// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {XLayerForkBase} from "./helpers/XLayerForkBase.sol";
import {EgressExecutor} from "../src/EgressExecutor.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IATokenPermit} from "../src/interfaces/IATokenPermit.sol";

contract EgressExecutorForkTest is XLayerForkBase {
    uint256 internal constant COLLATERAL = 50 ether;
    uint256 internal constant DEBT = 44.05 ether;
    uint256 internal constant REPAY = 11.1 ether;
    uint256 internal constant SELL = 11 ether;

    function setUp() public override {
        super.setUp();
        _createPosition(COLLATERAL, DEBT);
    }

    function testCompleteAtomicDeleverageWithDualAuthorization() external {
        uint256 quote = _quote(SELL);
        uint256 deadline = block.timestamp + 10 minutes;
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.07 ether, 1, deadline);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        uint256 debtBefore = IERC20(VDEBT_XETH).balanceOf(borrower);
        uint256 collateralBefore = IERC20(AXBETH).balanceOf(borrower);
        uint256 healthBefore = _healthFactor(borrower);
        uint256 userXethBefore = IERC20(XETH).balanceOf(borrower);
        uint256 permitNonceBefore = IATokenPermit(AXBETH).nonces(borrower);

        _execute(request);

        uint256 debtAfter = IERC20(VDEBT_XETH).balanceOf(borrower);
        uint256 collateralAfter = IERC20(AXBETH).balanceOf(borrower);
        uint256 healthAfter = _healthFactor(borrower);
        uint256 userXethAfter = IERC20(XETH).balanceOf(borrower);

        assertEq(debtBefore - debtAfter, REPAY, "debt repaid");
        assertEq(collateralBefore - collateralAfter, SELL, "collateral sold");
        assertGt(healthAfter, healthBefore, "health factor improves");
        assertGt(userXethAfter, userXethBefore, "surplus returned to user");
        assertEq(IATokenPermit(AXBETH).nonces(borrower), permitNonceBefore + 1, "permit consumed once");
        assertEq(egress.authorizationUsed(borrower, authorization.nonce), true, "authorization consumed");
        assertEq(IERC20(AXBETH).allowance(borrower, address(egress)), 0, "exact permit fully consumed");
        assertEq(IERC20(AXBETH).balanceOf(borrower), collateralAfter, "remaining collateral stays with user");
        assertEq(IERC20(XETH).balanceOf(address(egress)), 0, "no xETH residue");
        assertEq(IERC20(XBETH).balanceOf(address(egress)), 0, "no xBETH residue");
        assertEq(IERC20(AXBETH).balanceOf(address(egress)), 0, "no aXbETH residue");
        assertEq(IERC20(XETH).allowance(address(egress), AAVE_POOL), 0, "flash allowance consumed");
        assertEq(IERC20(XBETH).allowance(address(egress), SWAP_ROUTER), 0, "router allowance cleared");
    }

    function testPlannerAmountAcceptsOnlyAavesOneWeiDebtRounding() external {
        uint256 repayAmount = 10.85 ether;
        uint256 collateralAmount = 10_838_165_215_367_065_769;
        uint256 quote = _quote(collateralAmount);
        EgressExecutor.Authorization memory authorization =
            _authorization(repayAmount, collateralAmount, quote, 100, 1.065 ether, 23, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        uint256 debtBefore = IERC20(VDEBT_XETH).balanceOf(borrower);

        _execute(request);

        uint256 debtReduction = debtBefore - IERC20(VDEBT_XETH).balanceOf(borrower);
        assertApproxEqAbs(debtReduction, repayAmount, 1, "Aave debt rounding must stay within one wei");
        assertGt(_healthFactor(borrower), 1.065 ether, "post-action health factor");
    }

    function testExcessiveSlippageRevertsAtomically() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 2, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        request.authorization.minSwapOut = quote + 1;
        request.authorization.expectedSwapOut = quote + 1;
        request.authorization.maxSlippageBps = 10_000;
        request.authorizationSignature = _signAuthorization(request.authorization, BORROWER_KEY);
        _expectExecutionRollback(request, authorization.nonce);
    }

    function testMinimumOutputBelowAuthorizedSlippageFloorRevertsBeforePermit() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 15, block.timestamp + 10 minutes);
        authorization.minSwapOut -= 1;
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        vm.expectPartialRevert(EgressExecutor.SwapOutputBelowSlippageFloor.selector);
        _execute(request);
        assertEq(IATokenPermit(AXBETH).nonces(borrower), 0, "permit not consumed");
    }

    function testQuotedOutputCannotBeLowerThanSignedMinimum() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 16, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        request.authorization.expectedSwapOut = authorization.minSwapOut - 1;
        request.authorizationSignature = _signAuthorization(request.authorization, BORROWER_KEY);

        vm.expectPartialRevert(EgressExecutor.QuoteBelowSignedMinimum.selector);
        _execute(request);
    }

    function testInsufficientLiquidityRevertsAtomically() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 100, 1.01 ether, 3, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        request.authorization.minSwapOut = REPAY + 20 ether;
        request.authorization.expectedSwapOut = request.authorization.minSwapOut;
        request.authorization.maxSlippageBps = 10_000;
        request.authorizationSignature = _signAuthorization(request.authorization, BORROWER_KEY);
        _expectExecutionRollback(request, authorization.nonce);
    }

    function testHealthFactorBelowRequiredMinimumRevertsAtomically() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.2 ether, 4, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        _expectExecutionRollback(request, authorization.nonce);
    }

    function testAuthorizationExpiredReverts() external {
        uint256 quote = _quote(SELL);
        uint256 deadline = block.timestamp + 10;
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 5, deadline);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        vm.warp(deadline + 1);

        vm.expectPartialRevert(EgressExecutor.AuthorizationExpired.selector);
        _execute(request);
    }

    function testPermitDeadlineBeforeAuthorizationDeadlineRevertsBeforePermit() external {
        uint256 quote = _quote(SELL);
        uint256 authorizationDeadline = block.timestamp + 10 minutes;
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 6, authorizationDeadline);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        request.collateralPermit = _signPermit(SELL, authorizationDeadline - 1, BORROWER_KEY);

        vm.expectPartialRevert(EgressExecutor.PermitExpiresBeforeAuthorization.selector);
        _execute(request);
        assertEq(egress.authorizationUsed(borrower, authorization.nonce), false);
        assertEq(IATokenPermit(AXBETH).nonces(borrower), 0, "permit not consumed");
    }

    function testInvalidAuthorizationSignatureReverts() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 7, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        request.authorizationSignature = _signAuthorization(authorization, ATTACKER_KEY);

        vm.expectPartialRevert(EgressExecutor.InvalidAuthorizationSigner.selector);
        _execute(request);
    }

    function testInvalidPermitSignatureReverts() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 8, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        request.collateralPermit = _signPermit(SELL, authorization.deadline, ATTACKER_KEY);

        vm.expectRevert();
        _execute(request);
        assertEq(egress.authorizationUsed(borrower, authorization.nonce), false);
    }

    function testReplayedAuthorizationReverts() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 9, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        _execute(request);

        vm.expectPartialRevert(EgressExecutor.AuthorizationAlreadyUsed.selector);
        _execute(request);
    }

    function testUnauthorizedExecutorReverts() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 10, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        vm.prank(attacker);
        vm.expectPartialRevert(EgressExecutor.UnauthorizedExecutor.selector);
        egress.execute(request);
    }

    function testExcessiveRepaymentReverts() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 11, block.timestamp + 10 minutes);
        authorization.maxRepayment = REPAY - 1;
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        vm.expectPartialRevert(EgressExecutor.RepaymentExceedsMaximum.selector);
        _execute(request);
    }

    function testExcessiveCollateralReverts() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 12, block.timestamp + 10 minutes);
        authorization.maxCollateral = SELL - 1;
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        vm.expectPartialRevert(EgressExecutor.CollateralExceedsMaximum.selector);
        _execute(request);
    }

    function testUserRevocationReverts() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 13, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        vm.prank(borrower);
        egress.revokeAuthorizations();

        vm.expectPartialRevert(EgressExecutor.AuthorizationRevoked.selector);
        _execute(request);
    }

    function testGuardianPauseReverts() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 17, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        egress.setPaused(true);

        vm.expectRevert(EgressExecutor.Paused.selector);
        _execute(request);
    }

    function testNonGuardianCannotPause() external {
        vm.prank(attacker);
        vm.expectPartialRevert(EgressExecutor.NotGuardian.selector);
        egress.setPaused(true);
    }

    function testFlashLoanPremiumAboveSignedCeilingRevertsAtomically() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 18, block.timestamp + 10 minutes);
        authorization.maxFlashLoanPremiumBps = 4;
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        _expectExecutionRollback(request, authorization.nonce);
    }

    function testPreExistingExecutorDustIsPreservedRatherThanBlockingExecution() external {
        uint256 dust = 0.01 ether;
        vm.prank(borrower);
        bool transferred = IERC20(XETH).transfer(address(egress), dust);
        assertTrue(transferred, "dust transfer");

        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.07 ether, 19, block.timestamp + 10 minutes);
        _execute(_request(authorization));

        assertEq(IERC20(XETH).balanceOf(address(egress)), dust, "pre-existing xETH is preserved");
        assertEq(IERC20(XBETH).balanceOf(address(egress)), 0, "no xBETH created");
        assertEq(IERC20(AXBETH).balanceOf(address(egress)), 0, "no aXbETH created");
    }

    function testPermitCannotBeReplayedForANewAuthorization() external {
        uint256 quote = _quote(SELL);
        uint256 deadline = block.timestamp + 10 minutes;
        EgressExecutor.Authorization memory firstAuthorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 20, deadline);
        EgressExecutor.ExecutionRequest memory firstRequest = _request(firstAuthorization);
        _execute(firstRequest);

        EgressExecutor.Authorization memory secondAuthorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 21, deadline);
        EgressExecutor.ExecutionRequest memory secondRequest = EgressExecutor.ExecutionRequest({
            authorization: secondAuthorization,
            authorizationSignature: _signAuthorization(secondAuthorization, BORROWER_KEY),
            collateralPermit: firstRequest.collateralPermit
        });

        vm.expectRevert();
        _execute(secondRequest);
        assertEq(
            egress.authorizationUsed(borrower, secondAuthorization.nonce), false, "second authorization rolls back"
        );
    }

    function testFrontRunPermitDoesNotBlockAuthorizedExecution() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.07 ether, 22, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        vm.prank(attacker);
        IATokenPermit(AXBETH)
            .permit(
                borrower,
                address(egress),
                SELL,
                request.collateralPermit.deadline,
                request.collateralPermit.v,
                request.collateralPermit.r,
                request.collateralPermit.s
            );

        uint256 debtBefore = IERC20(VDEBT_XETH).balanceOf(borrower);
        _execute(request);

        assertEq(debtBefore - IERC20(VDEBT_XETH).balanceOf(borrower), REPAY, "debt repaid");
        assertEq(IERC20(AXBETH).allowance(borrower, address(egress)), 0, "front-run allowance consumed exactly");
    }

    function testSwapFailureRollsBackAtomically() external {
        uint256 quote = _quote(SELL);
        EgressExecutor.Authorization memory authorization =
            _authorization(REPAY, SELL, quote, 20, 1.01 ether, 14, block.timestamp + 10 minutes);
        EgressExecutor.ExecutionRequest memory request = _request(authorization);
        request.authorization.minSwapOut = type(uint256).max;
        request.authorization.expectedSwapOut = type(uint256).max;
        request.authorization.maxSlippageBps = 10_000;
        request.authorizationSignature = _signAuthorization(request.authorization, BORROWER_KEY);
        _expectExecutionRollback(request, authorization.nonce);
    }

    function testCannotCallFlashCallbackDirectly() external {
        vm.expectRevert(EgressExecutor.FlashLoanNotActive.selector);
        egress.executeOperation(XETH, 1 ether, 0, address(egress), "");
    }

    function _expectExecutionRollback(EgressExecutor.ExecutionRequest memory request, uint256 authorizationNonce)
        internal
    {
        uint256 debtBefore = IERC20(VDEBT_XETH).balanceOf(borrower);
        uint256 collateralBefore = IERC20(AXBETH).balanceOf(borrower);
        uint256 userXethBefore = IERC20(XETH).balanceOf(borrower);
        uint256 permitNonceBefore = IATokenPermit(AXBETH).nonces(borrower);

        vm.expectRevert();
        _execute(request);

        _assertAtomicState(debtBefore, collateralBefore, userXethBefore, permitNonceBefore, authorizationNonce, 0);
    }
}
