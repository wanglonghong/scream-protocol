const {
  etherUnsigned,
  etherMantissa,
  UInt256Max
} = require('../Utils/Ethereum');

const {
  makeCToken,
  balanceOf,
  borrowSnapshot,
  totalBorrows,
  fastForward,
  setBalance,
  preApprove,
  pretendBorrow
} = require('../Utils/Compound');

const borrowAmount = etherUnsigned(10e3);
const repayAmount = etherUnsigned(10e2);

async function preBorrow(cToken, borrower, borrowAmount) {
  await send(cToken.comptroller, 'setBorrowAllowed', [true]);
  await send(cToken.comptroller, 'setBorrowVerify', [true]);
  await send(cToken.interestRateModel, 'setFailBorrowRate', [false]);
  await send(cToken.underlying, 'harnessSetBalance', [cToken._address, borrowAmount]);
  await send(cToken, 'harnessSetFailTransferToAddress', [borrower, false]);
  await send(cToken, 'harnessSetAccountBorrows', [borrower, 0, 0]);
  await send(cToken, 'harnessSetTotalBorrows', [0]);
}

async function borrowFresh(cToken, borrower, borrowAmount) {
  return send(cToken, 'harnessBorrowFresh', [borrower, borrowAmount]);
}

async function borrow(cToken, borrower, borrowAmount, opts = {}) {
  // make sure to have a block delta so we accrue interest
  await send(cToken, 'harnessFastForward', [1]);
  return send(cToken, 'borrow', [borrowAmount], {from: borrower});
}

async function preRepay(cToken, benefactor, borrower, repayAmount) {
  // setup either benefactor OR borrower for success in repaying
  await send(cToken.comptroller, 'setRepayBorrowAllowed', [true]);
  await send(cToken.comptroller, 'setRepayBorrowVerify', [true]);
  await send(cToken.interestRateModel, 'setFailBorrowRate', [false]);
  await send(cToken.underlying, 'harnessSetFailTransferFromAddress', [benefactor, false]);
  await send(cToken.underlying, 'harnessSetFailTransferFromAddress', [borrower, false]);
  await pretendBorrow(cToken, borrower, 1, 1, repayAmount);
  await preApprove(cToken, benefactor, repayAmount);
  await preApprove(cToken, borrower, repayAmount);
}

async function repayBorrowFresh(cToken, payer, borrower, repayAmount) {
  return send(cToken, 'harnessRepayBorrowFresh', [payer, borrower, repayAmount], {from: payer});
}

async function repayBorrow(cToken, borrower, repayAmount) {
  // make sure to have a block delta so we accrue interest
  await send(cToken, 'harnessFastForward', [1]);
  return send(cToken, 'repayBorrow', [repayAmount], {from: borrower});
}

async function repayBorrowBehalf(cToken, payer, borrower, repayAmount) {
  // make sure to have a block delta so we accrue interest
  await send(cToken, 'harnessFastForward', [1]);
  return send(cToken, 'repayBorrowBehalf', [borrower, repayAmount], {from: payer});
}

async function fillMasterChef(cToken, amount) {
  const masterChefAddress = await call(cToken, 'masterChef', []);
  const masterChef = await saddle.getContractAt('MasterChef', masterChefAddress);
  await send(cToken.underlying, 'transfer', [masterChefAddress, amount]);
  await send(masterChef, 'harnessSetUserAmount', [0, cToken._address, amount]);
}

describe('CToken', function () {
  let cToken, root, minter, borrower, benefactor, accounts;
  beforeEach(async () => {
    [root, minter, borrower, benefactor, ...accounts] = saddle.accounts;
    cToken = await makeCToken({kind: 'cslp', comptrollerOpts: {kind: 'bool'}});
  });

  describe('borrowFresh', () => {
    beforeEach(async () => await preBorrow(cToken, borrower, borrowAmount));

    it("fails if comptroller tells it to", async () => {
      await send(cToken.comptroller, 'setBorrowAllowed', [false]);
      expect(await borrowFresh(cToken, borrower, borrowAmount)).toHaveTrollReject('BORROW_COMPTROLLER_REJECTION');
    });

    it("proceeds if comptroller tells it to", async () => {
      await fillMasterChef(cToken, borrowAmount);
      expect(await borrowFresh(cToken, borrower, borrowAmount)).toSucceed();
    });

    it("fails if market not fresh", async () => {
      await fastForward(cToken);
      expect(await borrowFresh(cToken, borrower, borrowAmount)).toHaveTokenFailure('MARKET_NOT_FRESH', 'BORROW_FRESHNESS_CHECK');
    });

    it("continues if fresh", async () => {
      expect(await send(cToken, 'accrueInterest')).toSucceed();
      await fillMasterChef(cToken, borrowAmount);
      expect(await borrowFresh(cToken, borrower, borrowAmount)).toSucceed();
    });

    it("fails if error if protocol has less than borrowAmount of underlying", async () => {
      expect(await borrowFresh(cToken, borrower, borrowAmount.plus(1))).toHaveTokenFailure('TOKEN_INSUFFICIENT_CASH', 'BORROW_CASH_NOT_AVAILABLE');
    });

    it("fails if borrowBalanceStored fails (due to non-zero stored principal with zero account index)", async () => {
      await pretendBorrow(cToken, borrower, 0, 3e18, 5e18);
      await fillMasterChef(cToken, borrowAmount);
      await expect(borrowFresh(cToken, borrower, borrowAmount)).rejects.toRevert("revert divide by zero");
    });

    it("fails if calculating account new total borrow balance overflows", async () => {
      await pretendBorrow(cToken, borrower, 1e-18, 1e-18, UInt256Max());
      await fillMasterChef(cToken, borrowAmount);
      await expect(borrowFresh(cToken, borrower, borrowAmount)).rejects.toRevert("revert addition overflow");
    });

    it("fails if calculation of new total borrow balance overflows", async () => {
      await send(cToken, 'harnessSetTotalBorrows', [UInt256Max()]);
      await fillMasterChef(cToken, borrowAmount);
      await expect(borrowFresh(cToken, borrower, borrowAmount)).rejects.toRevert("revert addition overflow");
    });

    it("reverts if transfer out fails", async () => {
      await send(cToken.underlying, 'harnessSetFailTransferToAddress', [borrower, true]);
      await fillMasterChef(cToken, borrowAmount);
      await expect(borrowFresh(cToken, borrower, borrowAmount)).rejects.toRevert("revert unexpected EIP-20 transfer out return");
    });

    xit("reverts if borrowVerify fails", async() => {
      await send(cToken.comptroller, 'setBorrowVerify', [false]);
      await fillMasterChef(cToken, borrowAmount);
      await expect(borrowFresh(cToken, borrower, borrowAmount)).rejects.toRevert("revert borrowVerify rejected borrow");
    });

    it("transfers the underlying cash, tokens, and emits Transfer, Borrow events", async () => {
      await fillMasterChef(cToken, borrowAmount);
      const masterChefAddress = await call(cToken, 'masterChef', []);

      const beforeProtocolCash = await balanceOf(cToken.underlying, cToken._address);
      const beforeProtocolBorrows = await totalBorrows(cToken);
      const beforeAccountCash = await balanceOf(cToken.underlying, borrower);
      const result = await borrowFresh(cToken, borrower, borrowAmount);
      expect(result).toSucceed();
      expect(await balanceOf(cToken.underlying, borrower)).toEqualNumber(beforeAccountCash.plus(borrowAmount));
      expect(await balanceOf(cToken.underlying, masterChefAddress)).toEqualNumber(beforeProtocolCash.minus(borrowAmount));
      expect(await totalBorrows(cToken)).toEqualNumber(beforeProtocolBorrows.plus(borrowAmount));
      expect(result).toHaveLog('Transfer', {
        from: cToken._address,
        to: borrower,
        amount: borrowAmount.toString()
      });
      expect(result).toHaveLog('Borrow', {
        borrower: borrower,
        borrowAmount: borrowAmount.toString(),
        accountBorrows: borrowAmount.toString(),
        totalBorrows: beforeProtocolBorrows.plus(borrowAmount).toString()
      });
    });

    it("stores new borrow principal and interest index", async () => {
      await fillMasterChef(cToken, borrowAmount);

      const beforeProtocolBorrows = await totalBorrows(cToken);
      await pretendBorrow(cToken, borrower, 0, 3, 0);
      await borrowFresh(cToken, borrower, borrowAmount);
      const borrowSnap = await borrowSnapshot(cToken, borrower);
      expect(borrowSnap.principal).toEqualNumber(borrowAmount);
      expect(borrowSnap.interestIndex).toEqualNumber(etherMantissa(3));
      expect(await totalBorrows(cToken)).toEqualNumber(beforeProtocolBorrows.plus(borrowAmount));
    });
  });

  describe('borrow', () => {
    beforeEach(async () => await preBorrow(cToken, borrower, borrowAmount));

    it("emits a borrow failure if interest accrual fails", async () => {
      await send(cToken.interestRateModel, 'setFailBorrowRate', [true]);
      await expect(borrow(cToken, borrower, borrowAmount)).rejects.toRevert("revert INTEREST_RATE_MODEL_ERROR");
    });

    it("returns error from borrowFresh without emitting any extra logs", async () => {
      expect(await borrow(cToken, borrower, borrowAmount.plus(1))).toHaveTokenFailure('TOKEN_INSUFFICIENT_CASH', 'BORROW_CASH_NOT_AVAILABLE');
    });

    it("returns success from borrowFresh and transfers the correct amount", async () => {
      const beforeAccountCash = await balanceOf(cToken.underlying, borrower);
      await fastForward(cToken);
      await fillMasterChef(cToken, borrowAmount);
      expect(await borrow(cToken, borrower, borrowAmount)).toSucceed();
      expect(await balanceOf(cToken.underlying, borrower)).toEqualNumber(beforeAccountCash.plus(borrowAmount));
    });

    it("gets no sushi reward when borrowing", async () => {
      const sushiAddress = await call(cToken, 'sushi', []);
      const masterChefAddress = await call(cToken, 'masterChef', []);

      const sushi = await saddle.getContractAt('SushiToken', sushiAddress);
      const masterChef = await saddle.getContractAt('MasterChef', masterChefAddress);

      await fastForward(masterChef, 1);
      await fillMasterChef(cToken, borrowAmount);

      expect(await borrow(cToken, borrower, borrowAmount)).toSucceed();
      expect(await balanceOf(sushi, borrower)).toEqualNumber(etherUnsigned(0));
    });
  });

  describe('repayBorrowFresh', () => {
    [true, false].forEach((benefactorIsPayer) => {
      let payer;
      const label = benefactorIsPayer ? "benefactor paying" : "borrower paying";
      describe(label, () => {
        beforeEach(async () => {
          payer = benefactorIsPayer ? benefactor : borrower;
          await preRepay(cToken, payer, borrower, repayAmount);
        });

        it("fails if repay is not allowed", async () => {
          await send(cToken.comptroller, 'setRepayBorrowAllowed', [false]);
          expect(await repayBorrowFresh(cToken, payer, borrower, repayAmount)).toHaveTrollReject('REPAY_BORROW_COMPTROLLER_REJECTION', 'MATH_ERROR');
        });

        it("fails if block number ≠ current block number", async () => {
          await fastForward(cToken);
          expect(await repayBorrowFresh(cToken, payer, borrower, repayAmount)).toHaveTokenFailure('MARKET_NOT_FRESH', 'REPAY_BORROW_FRESHNESS_CHECK');
        });

        it("fails if insufficient approval", async() => {
          await preApprove(cToken, payer, 1);
          await expect(repayBorrowFresh(cToken, payer, borrower, repayAmount)).rejects.toRevert('revert Insufficient allowance');
        });

        it("fails if insufficient balance", async() => {
          await setBalance(cToken.underlying, payer, 1);
          await expect(repayBorrowFresh(cToken, payer, borrower, repayAmount)).rejects.toRevert('revert Insufficient balance');
        });


        it("returns an error if calculating account new account borrow balance fails", async () => {
          await pretendBorrow(cToken, borrower, 1, 1, 1);
          await expect(repayBorrowFresh(cToken, payer, borrower, repayAmount)).rejects.toRevert("revert subtraction underflow");
        });

        it("returns an error if calculation of new total borrow balance fails", async () => {
          await send(cToken, 'harnessSetTotalBorrows', [1]);
          await expect(repayBorrowFresh(cToken, payer, borrower, repayAmount)).rejects.toRevert("revert subtraction underflow");
        });


        it("reverts if doTransferIn fails", async () => {
          await send(cToken.underlying, 'harnessSetFailTransferFromAddress', [payer, true]);
          await expect(repayBorrowFresh(cToken, payer, borrower, repayAmount)).rejects.toRevert("revert unexpected EIP-20 transfer in return");
        });

        xit("reverts if repayBorrowVerify fails", async() => {
          await send(cToken.comptroller, 'setRepayBorrowVerify', [false]);
          await expect(repayBorrowFresh(cToken, payer, borrower, repayAmount)).rejects.toRevert("revert repayBorrowVerify rejected repayBorrow");
        });

        it("transfers the underlying cash, and emits Transfer, RepayBorrow events", async () => {
          const masterChefAddress = await call(cToken, 'masterChef', []);
          const beforeProtocolCash = await balanceOf(cToken.underlying, cToken._address);
          const result = await repayBorrowFresh(cToken, payer, borrower, repayAmount);
          expect(await balanceOf(cToken.underlying, masterChefAddress)).toEqualNumber(beforeProtocolCash.plus(repayAmount));
          expect(result).toHaveLog(['Transfer', 0], {
            from: payer,
            to: cToken._address,
            amount: repayAmount.toString()
          });
          expect(result).toHaveLog('RepayBorrow', {
            payer: payer,
            borrower: borrower,
            repayAmount: repayAmount.toString(),
            accountBorrows: "0",
            totalBorrows: "0"
          });
        });

        it("stores new borrow principal and interest index", async () => {
          const beforeProtocolBorrows = await totalBorrows(cToken);
          const beforeAccountBorrowSnap = await borrowSnapshot(cToken, borrower);
          expect(await repayBorrowFresh(cToken, payer, borrower, repayAmount)).toSucceed();
          const afterAccountBorrows = await borrowSnapshot(cToken, borrower);
          expect(afterAccountBorrows.principal).toEqualNumber(beforeAccountBorrowSnap.principal.minus(repayAmount));
          expect(afterAccountBorrows.interestIndex).toEqualNumber(etherMantissa(1));
          expect(await totalBorrows(cToken)).toEqualNumber(beforeProtocolBorrows.minus(repayAmount));
        });
      });
    });
  });

  describe('repayBorrow', () => {
    beforeEach(async () => {
      await preRepay(cToken, borrower, borrower, repayAmount);
    });

    it("emits a repay borrow failure if interest accrual fails", async () => {
      await send(cToken.interestRateModel, 'setFailBorrowRate', [true]);
      await expect(repayBorrow(cToken, borrower, repayAmount)).rejects.toRevert("revert INTEREST_RATE_MODEL_ERROR");
    });

    it("returns error from repayBorrowFresh without emitting any extra logs", async () => {
      await setBalance(cToken.underlying, borrower, 1);
      await expect(repayBorrow(cToken, borrower, repayAmount)).rejects.toRevert('revert Insufficient balance');
    });

    it("returns success from repayBorrowFresh and repays the right amount", async () => {
      await fastForward(cToken);
      const beforeAccountBorrowSnap = await borrowSnapshot(cToken, borrower);
      expect(await repayBorrow(cToken, borrower, repayAmount)).toSucceed();
      const afterAccountBorrowSnap = await borrowSnapshot(cToken, borrower);
      expect(afterAccountBorrowSnap.principal).toEqualNumber(beforeAccountBorrowSnap.principal.minus(repayAmount));
    });

    it("repays the full amount owed if payer has enough", async () => {
      await fastForward(cToken);
      expect(await repayBorrow(cToken, borrower, UInt256Max())).toSucceed();
      const afterAccountBorrowSnap = await borrowSnapshot(cToken, borrower);
      expect(afterAccountBorrowSnap.principal).toEqualNumber(0);
    });

    it("fails gracefully if payer does not have enough", async () => {
      await setBalance(cToken.underlying, borrower, 3);
      await fastForward(cToken);
      await expect(repayBorrow(cToken, borrower, UInt256Max())).rejects.toRevert('revert Insufficient balance');
    });

    it("gets no sushi reward when repaying", async () => {
      const sushiAddress = await call(cToken, 'sushi', []);
      const masterChefAddress = await call(cToken, 'masterChef', []);

      const sushi = await saddle.getContractAt('SushiToken', sushiAddress);
      const masterChef = await saddle.getContractAt('MasterChef', masterChefAddress);

      await fastForward(masterChef, 1);
      await fillMasterChef(cToken, borrowAmount);

      expect(await repayBorrow(cToken, borrower, repayAmount)).toSucceed();
      expect(await balanceOf(sushi, borrower)).toEqualNumber(etherUnsigned(0));
    });
  });

  describe('repayBorrowBehalf', () => {
    let payer;

    beforeEach(async () => {
      payer = benefactor;
      await preRepay(cToken, payer, borrower, repayAmount);
    });

    it("emits a repay borrow failure if interest accrual fails", async () => {
      await send(cToken.interestRateModel, 'setFailBorrowRate', [true]);
      await expect(repayBorrowBehalf(cToken, payer, borrower, repayAmount)).rejects.toRevert("revert INTEREST_RATE_MODEL_ERROR");
    });

    it("returns error from repayBorrowFresh without emitting any extra logs", async () => {
      await setBalance(cToken.underlying, payer, 1);
      await expect(repayBorrowBehalf(cToken, payer, borrower, repayAmount)).rejects.toRevert('revert Insufficient balance');
    });

    it("returns success from repayBorrowFresh and repays the right amount", async () => {
      await fastForward(cToken);
      const beforeAccountBorrowSnap = await borrowSnapshot(cToken, borrower);
      expect(await repayBorrowBehalf(cToken, payer, borrower, repayAmount)).toSucceed();
      const afterAccountBorrowSnap = await borrowSnapshot(cToken, borrower);
      expect(afterAccountBorrowSnap.principal).toEqualNumber(beforeAccountBorrowSnap.principal.minus(repayAmount));
    });

    it("gets no sushi reward when repaying on behalf", async () => {
      const sushiAddress = await call(cToken, 'sushi', []);
      const masterChefAddress = await call(cToken, 'masterChef', []);

      const sushi = await saddle.getContractAt('SushiToken', sushiAddress);
      const masterChef = await saddle.getContractAt('MasterChef', masterChefAddress);

      await fastForward(masterChef, 1);
      await fillMasterChef(cToken, borrowAmount);

      expect(await repayBorrowBehalf(cToken, payer, borrower, repayAmount)).toSucceed();
      expect(await balanceOf(sushi, borrower)).toEqualNumber(etherUnsigned(0));
    });
  });
});
