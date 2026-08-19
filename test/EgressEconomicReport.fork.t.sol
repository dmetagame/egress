// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {XLayerForkBase} from "./helpers/XLayerForkBase.sol";
import {EgressExecutor} from "../src/EgressExecutor.sol";
import {IAavePool} from "../src/interfaces/IAavePool.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface IUniswapPoolState {
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

contract EgressEconomicReportForkTest is XLayerForkBase {
    uint256 internal constant BPS = 10_000;
    address internal constant WOKB = 0xe538905cf8410324e03A5A23C1c177a474D59b2b;

    struct Scenario {
        string id;
        string title;
        uint256 collateral;
        uint256 debt;
        uint256 repay;
        uint256 collateralSold;
        uint256 targetHealthFactor;
        uint256 authorizationNonce;
    }

    struct Metrics {
        uint256 collateralBefore;
        uint256 debtBefore;
        uint256 healthBefore;
        uint256 xbEthPriceUsd8;
        uint256 xethPriceUsd8;
        uint256 poolXbEthBefore;
        uint256 poolXethBefore;
        uint256 poolLiquidityBefore;
        uint256 sqrtPriceBefore;
        uint256 quoteOut;
        uint256 spotExpectedOut;
        uint256 minSwapOut;
        uint256 gasUsed;
        uint256 gasPriceWei;
        uint256 collateralAfter;
        uint256 debtAfter;
        uint256 healthAfter;
        uint256 userXethSurplus;
        uint256 swapOut;
        uint256 flashPremium;
        uint256 swapPriceXethPerXbethWad;
        uint256 priceImpactBps;
        uint256 realizedSlippageBps;
        uint256 uniswapFeeXbeth;
        uint256 swapExecutionLossXeth;
        uint256 gasCostOkb;
        uint256 gasCostUsd8;
        uint256 flashPremiumUsd8;
        uint256 uniswapFeeUsd8;
        uint256 swapExecutionLossUsd8;
        uint256 totalExecutionCostUsd8;
        uint256 liquidationBonusBps;
        uint256 estimatedLiquidationPenaltyUsd8;
        uint256 estimatedNetBenefitUsd8;
    }

    function testGenerateScenarioAReport() external {
        _generate(
            Scenario({
                id: "scenario-a-moderate",
                title: "Scenario A - Moderate position",
                collateral: 50 ether,
                debt: 44.05 ether,
                repay: 11.1 ether,
                collateralSold: 11 ether,
                targetHealthFactor: 1.07 ether,
                authorizationNonce: 1001
            })
        );
    }

    function testGenerateScenarioBReport() external {
        // The requested 344/300 position is retained. The action is bounded to 58.5 xBETH because
        // it restores the target health factor while remaining inside the measured single-pool depth.
        _generate(
            Scenario({
                id: "scenario-b-larger",
                title: "Scenario B - Larger position",
                collateral: 344 ether,
                debt: 300 ether,
                repay: 58.8 ether,
                collateralSold: 58.5 ether,
                targetHealthFactor: 1.07 ether,
                authorizationNonce: 1002
            })
        );
    }

    function _generate(Scenario memory scenario) internal {
        _createPosition(scenario.collateral, scenario.debt);
        Metrics memory m;
        m.collateralBefore = IERC20(AXBETH).balanceOf(borrower);
        m.debtBefore = IERC20(VDEBT_XETH).balanceOf(borrower);
        m.healthBefore = _healthFactor(borrower);
        m.xbEthPriceUsd8 = _oraclePrice(XBETH);
        m.xethPriceUsd8 = _oraclePrice(XETH);
        m.poolXbEthBefore = IERC20(XBETH).balanceOf(SWAP_POOL);
        m.poolXethBefore = IERC20(XETH).balanceOf(SWAP_POOL);
        m.poolLiquidityBefore = IUniswapPoolState(SWAP_POOL).liquidity();
        (m.sqrtPriceBefore,,,,,,) = IUniswapPoolState(SWAP_POOL).slot0();
        m.quoteOut = _quote(scenario.collateralSold);
        m.spotExpectedOut = _spotExpectedOut(scenario.collateralSold, m.sqrtPriceBefore);
        m.minSwapOut = m.quoteOut * 9980 / 10_000;

        EgressExecutor.Authorization memory authorization = _authorization(
            scenario.repay,
            scenario.collateralSold,
            m.quoteOut,
            20,
            scenario.targetHealthFactor,
            scenario.authorizationNonce,
            block.timestamp + 10 minutes
        );
        EgressExecutor.ExecutionRequest memory request = _request(authorization);

        uint256 userXethBefore = IERC20(XETH).balanceOf(borrower);
        vm.txGasPrice(block.basefee);
        vm.prank(keeper);
        egress.execute(request);
        m.gasUsed = vm.lastCallGas().gasTotalUsed;
        m.gasPriceWei = block.basefee;

        m.collateralAfter = IERC20(AXBETH).balanceOf(borrower);
        m.debtAfter = IERC20(VDEBT_XETH).balanceOf(borrower);
        m.healthAfter = _healthFactor(borrower);
        m.userXethSurplus = IERC20(XETH).balanceOf(borrower) - userXethBefore;
        m.flashPremium = scenario.repay * 5 / 10_000;
        m.swapOut = scenario.repay + m.flashPremium + m.userXethSurplus;
        m.swapPriceXethPerXbethWad = m.swapOut * 1 ether / scenario.collateralSold;
        m.priceImpactBps = _deviationBps(m.spotExpectedOut, m.swapOut);
        m.realizedSlippageBps = _deviationBps(m.quoteOut, m.swapOut);
        m.uniswapFeeXbeth = scenario.collateralSold * POOL_FEE / 1_000_000;
        m.swapExecutionLossXeth = m.spotExpectedOut > m.swapOut ? m.spotExpectedOut - m.swapOut : 0;
        m.gasCostOkb = m.gasUsed * m.gasPriceWei;
        uint256 okbPriceUsd8 = _oraclePrice(WOKB);
        m.gasCostUsd8 = m.gasCostOkb * okbPriceUsd8 / 1 ether;
        m.flashPremiumUsd8 = m.flashPremium * m.xethPriceUsd8 / 1 ether;
        m.uniswapFeeUsd8 = m.uniswapFeeXbeth * m.xbEthPriceUsd8 / 1 ether;
        m.swapExecutionLossUsd8 = m.swapExecutionLossXeth * m.xethPriceUsd8 / 1 ether;
        m.totalExecutionCostUsd8 = m.gasCostUsd8 + m.flashPremiumUsd8 + m.swapExecutionLossUsd8;

        IAavePool.EModeCategory memory eMode = IAavePool(AAVE_POOL).getEModeCategoryData(EMODE_CATEGORY);
        m.liquidationBonusBps = uint256(eMode.liquidationBonus) - BPS;
        m.estimatedLiquidationPenaltyUsd8 = scenario.repay * m.xethPriceUsd8 / 1 ether * m.liquidationBonusBps / BPS;
        m.estimatedNetBenefitUsd8 = m.estimatedLiquidationPenaltyUsd8 > m.totalExecutionCostUsd8
            ? m.estimatedLiquidationPenaltyUsd8 - m.totalExecutionCostUsd8
            : 0;

        assertEq(m.debtBefore - m.debtAfter, scenario.repay, "report debt delta");
        assertEq(m.collateralBefore - m.collateralAfter, scenario.collateralSold, "report collateral delta");
        assertGt(m.healthAfter, m.healthBefore, "report health improvement");
        assertGe(m.swapOut, m.minSwapOut, "report slippage bound");

        _writeJson(scenario, m);
        _writeMarkdown(scenario, m);
    }

    function _writeJson(Scenario memory scenario, Metrics memory m) internal {
        string memory root = string.concat("egress-", scenario.id);
        vm.serializeString(root, "label", "FORK SIMULATION");
        vm.serializeUint(root, "schemaVersion", 1);
        vm.serializeString(root, "scenario", scenario.title);
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "forkBlock", FORK_BLOCK);
        vm.serializeString(root, "rpc", XLAYER_RPC);
        vm.serializeAddress(root, "egressExecutor", address(egress));

        vm.serializeString(root, "positionBeforeCollateralWei", vm.toString(m.collateralBefore));
        vm.serializeString(root, "positionBeforeDebtWei", vm.toString(m.debtBefore));
        vm.serializeString(root, "positionBeforeHealthFactorWad", vm.toString(m.healthBefore));
        vm.serializeUint(root, "xbethPriceUsd8", m.xbEthPriceUsd8);
        vm.serializeUint(root, "xethPriceUsd8", m.xethPriceUsd8);
        vm.serializeString(root, "poolXbethBalanceWei", vm.toString(m.poolXbEthBefore));
        vm.serializeString(root, "poolXethBalanceWei", vm.toString(m.poolXethBefore));
        vm.serializeString(root, "poolLiquidity", vm.toString(m.poolLiquidityBefore));

        vm.serializeString(root, "flashLoanWei", vm.toString(scenario.repay));
        vm.serializeString(root, "debtRepaidWei", vm.toString(scenario.repay));
        vm.serializeString(root, "collateralWithdrawnWei", vm.toString(scenario.collateralSold));
        vm.serializeString(root, "quotedSwapOutWei", vm.toString(m.quoteOut));
        vm.serializeString(root, "actualSwapOutWei", vm.toString(m.swapOut));
        vm.serializeString(root, "minimumSwapOutWei", vm.toString(m.minSwapOut));
        vm.serializeString(root, "flashPremiumWei", vm.toString(m.flashPremium));
        vm.serializeString(root, "surplusReturnedWei", vm.toString(m.userXethSurplus));
        vm.serializeString(root, "swapPriceXethPerXbethWad", vm.toString(m.swapPriceXethPerXbethWad));
        vm.serializeUint(root, "priceImpactBps", m.priceImpactBps);
        vm.serializeUint(root, "realizedSlippageBps", m.realizedSlippageBps);
        vm.serializeString(root, "uniswapFeeXbethWei", vm.toString(m.uniswapFeeXbeth));
        vm.serializeString(root, "swapExecutionLossXethWei", vm.toString(m.swapExecutionLossXeth));
        vm.serializeUint(root, "gasUsed", m.gasUsed);
        vm.serializeUint(root, "gasPriceWei", m.gasPriceWei);

        vm.serializeString(root, "positionAfterCollateralWei", vm.toString(m.collateralAfter));
        vm.serializeString(root, "positionAfterDebtWei", vm.toString(m.debtAfter));
        vm.serializeString(root, "positionAfterHealthFactorWad", vm.toString(m.healthAfter));

        vm.serializeString(root, "gasCostOkbWei", vm.toString(m.gasCostOkb));
        vm.serializeUint(root, "gasCostUsd8", m.gasCostUsd8);
        vm.serializeUint(root, "flashPremiumUsd8", m.flashPremiumUsd8);
        vm.serializeUint(root, "uniswapFeeUsd8", m.uniswapFeeUsd8);
        vm.serializeUint(root, "swapExecutionLossUsd8", m.swapExecutionLossUsd8);
        vm.serializeUint(root, "totalExecutionCostUsd8", m.totalExecutionCostUsd8);
        vm.serializeUint(root, "liquidationBonusBps", m.liquidationBonusBps);
        vm.serializeUint(root, "estimatedLiquidationPenaltyAvoidedUsd8", m.estimatedLiquidationPenaltyUsd8);
        string memory json = vm.serializeUint(root, "estimatedNetEconomicBenefitUsd8", m.estimatedNetBenefitUsd8);

        vm.writeJson(json, string.concat("reports/generated/", scenario.id, ".json"));
    }

    function _writeMarkdown(Scenario memory scenario, Metrics memory m) internal {
        string memory markdown = string.concat(
            "# ",
            scenario.title,
            "\n\n> **FORK SIMULATION** - This is a deterministic X Layer mainnet fork result, not a live user transaction.\n\n",
            "- Chain ID: `",
            vm.toString(block.chainid),
            "`\n- Fork block: `",
            vm.toString(FORK_BLOCK),
            "`\n- Egress executor (ephemeral fork deployment): `",
            vm.toString(address(egress)),
            "`\n\n"
        );

        markdown = string.concat(
            markdown,
            "## Position before\n\n",
            "- Collateral: `",
            _format18(m.collateralBefore),
            " xBETH`\n- Debt: `",
            _format18(m.debtBefore),
            " xETH`\n- Health factor: `",
            _format18(m.healthBefore),
            "`\n- xBETH oracle price: `$",
            _format8(m.xbEthPriceUsd8),
            "`\n- xETH oracle price: `$",
            _format8(m.xethPriceUsd8),
            "`\n- Pool balances: `",
            _format18(m.poolXbEthBefore),
            " xBETH / ",
            _format18(m.poolXethBefore),
            " xETH`\n- Active V3 liquidity: `",
            vm.toString(m.poolLiquidityBefore),
            "`\n\n"
        );

        markdown = string.concat(
            markdown,
            "## Execution\n\n",
            "- Flash loan / debt repaid: `",
            _format18(scenario.repay),
            " xETH`\n- Collateral withdrawn and sold: `",
            _format18(scenario.collateralSold),
            " xBETH`\n- Quoted swap output: `",
            _format18(m.quoteOut),
            " xETH`\n- Actual swap output: `",
            _format18(m.swapOut),
            " xETH`\n- Swap price: `",
            _format18(m.swapPriceXethPerXbethWad),
            " xETH/xBETH`\n- Price impact versus current pool spot: `",
            _formatBps(m.priceImpactBps),
            "`\n- Realized slippage versus quote: `",
            _formatBps(m.realizedSlippageBps),
            "`\n- Uniswap fee: `",
            _format18(m.uniswapFeeXbeth),
            " xBETH`\n- Flash-loan premium: `",
            _format18(m.flashPremium),
            " xETH`\n- Surplus returned to user: `",
            _format18(m.userXethSurplus),
            " xETH`\n- Gas used: `",
            vm.toString(m.gasUsed),
            "`\n\n"
        );

        markdown = string.concat(
            markdown,
            "## Position after\n\n",
            "- Collateral: `",
            _format18(m.collateralAfter),
            " xBETH`\n- Debt: `",
            _format18(m.debtAfter),
            " xETH`\n- Health factor: `",
            _format18(m.healthAfter),
            "`\n\n"
        );

        markdown = string.concat(
            markdown,
            "## Economics\n\n",
            "- Estimated gas cost: `$",
            _format8(m.gasCostUsd8),
            "` at pinned-block base fee and OKB oracle price\n- Flash premium: `$",
            _format8(m.flashPremiumUsd8),
            "`\n- Uniswap fee: `$",
            _format8(m.uniswapFeeUsd8),
            "` (informational; already included in swap execution loss)\n- Swap execution loss versus pre-swap spot, including LP fee and curve impact: `$",
            _format8(m.swapExecutionLossUsd8),
            "`\n- Total measured execution cost: `$",
            _format8(m.totalExecutionCostUsd8),
            "`\n- Estimated ",
            _formatBps(m.liquidationBonusBps),
            " e-mode liquidation penalty on the repaid debt value: `$",
            _format8(m.estimatedLiquidationPenaltyUsd8),
            "`\n- Estimated net economic benefit: `$",
            _format8(m.estimatedNetBenefitUsd8),
            "`\n\n",
            "The liquidation comparison is an estimate, not a guarantee: it applies the pinned e-mode liquidation bonus to the repaid debt value and excludes market movement, liquidation close-factor behavior, oracle/DEX divergence, and external redemption costs. The Uniswap fee is shown separately for transparency but is not added twice to total execution cost.\n"
        );

        vm.writeFile(string.concat("reports/generated/", scenario.id, ".md"), markdown);
    }

    function _spotExpectedOut(uint256 amountIn, uint256 sqrtPriceX96) internal pure returns (uint256) {
        uint256 scaled = sqrtPriceX96 * 1e18 / (2 ** 96);
        uint256 priceWad = scaled * scaled / 1e18;
        return amountIn * priceWad / 1e18;
    }

    function _deviationBps(uint256 referenceValue, uint256 actual) internal pure returns (uint256) {
        if (referenceValue == 0) return 0;
        uint256 delta = referenceValue > actual ? referenceValue - actual : actual - referenceValue;
        return delta * BPS / referenceValue;
    }

    function _format18(uint256 value) internal pure returns (string memory) {
        return _formatFixed(value, 18, 6);
    }

    function _format8(uint256 value) internal pure returns (string memory) {
        return _formatFixed(value, 8, 4);
    }

    function _formatBps(uint256 value) internal pure returns (string memory) {
        return string.concat(_uintToString(value / 100), ".", _pad2(value % 100), "%");
    }

    function _formatFixed(uint256 value, uint256 decimals, uint256 shownDecimals)
        internal
        pure
        returns (string memory)
    {
        uint256 unit = 10 ** decimals;
        uint256 integer = value / unit;
        uint256 fractional = value % unit / (10 ** (decimals - shownDecimals));
        return string.concat(_uintToString(integer), ".", _pad(fractional, shownDecimals));
    }

    function _pad2(uint256 value) internal pure returns (string memory) {
        return value < 10 ? string.concat("0", _uintToString(value)) : _uintToString(value);
    }

    function _pad(uint256 value, uint256 width) internal pure returns (string memory) {
        string memory raw = _uintToString(value);
        bytes memory rawBytes = bytes(raw);
        if (rawBytes.length >= width) return raw;
        bytes memory output = new bytes(width);
        uint256 padding = width - rawBytes.length;
        for (uint256 i; i < padding; ++i) {
            output[i] = bytes1("0");
        }
        for (uint256 i; i < rawBytes.length; ++i) {
            output[padding + i] = rawBytes[i];
        }
        return string(output);
    }

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            ++digits;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            --digits;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
