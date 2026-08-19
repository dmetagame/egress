// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {XLayerForkBase} from "./helpers/XLayerForkBase.sol";
import {EgressExecutor} from "../src/EgressExecutor.sol";
import {IPoolAddressesProvider} from "../src/interfaces/IAavePool.sol";

contract EgressExecutorConstructorForkTest is XLayerForkBase {
    function testWrongAavePoolConfigurationReverts() external {
        EgressExecutor.ProtocolConfig memory config = _validConfig();
        config.pool = SWAP_POOL;
        vm.expectRevert();
        new EgressExecutor(config);
    }

    function testWrongSwapPoolConfigurationReverts() external {
        EgressExecutor.ProtocolConfig memory config = _validConfig();
        config.swapPool = AAVE_POOL;
        vm.expectRevert();
        new EgressExecutor(config);
    }

    function testWrongSwapRouterConfigurationReverts() external {
        EgressExecutor.ProtocolConfig memory config = _validConfig();
        config.swapRouter = AAVE_POOL;
        vm.expectRevert();
        new EgressExecutor(config);
    }

    function testWrongTokenConfigurationReverts() external {
        EgressExecutor.ProtocolConfig memory config = _validConfig();
        config.xbEth = XETH;
        vm.expectRevert(EgressExecutor.InvalidProtocolConfiguration.selector);
        new EgressExecutor(config);
    }

    function testProviderThatDoesNotResolveToConfiguredPoolReverts() external {
        vm.mockCall(
            ADDRESSES_PROVIDER, abi.encodeWithSelector(IPoolAddressesProvider.getPool.selector), abi.encode(SWAP_POOL)
        );

        vm.expectRevert(EgressExecutor.InvalidProtocolConfiguration.selector);
        new EgressExecutor(_validConfig());
    }

    function _validConfig() internal pure returns (EgressExecutor.ProtocolConfig memory config) {
        config = EgressExecutor.ProtocolConfig({
            pool: AAVE_POOL,
            poolAddressesProvider: ADDRESSES_PROVIDER,
            aaveOracle: AAVE_ORACLE,
            xeth: XETH,
            xbEth: XBETH,
            aXbEth: AXBETH,
            variableDebtXeth: VDEBT_XETH,
            uniswapFactory: UNISWAP_FACTORY,
            swapRouter: SWAP_ROUTER,
            swapPool: SWAP_POOL,
            poolFee: POOL_FEE
        });
    }
}
