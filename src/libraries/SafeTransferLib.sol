// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

library SafeTransferLib {
    error TokenCallFailed(address token, bytes4 selector);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token, 0xa9059cbb);
        }
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token, 0x23b872dd);
        }
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        if (_callOptionalReturnBool(token, abi.encodeWithSelector(0x095ea7b3, spender, amount))) return;
        if (!_callOptionalReturnBool(token, abi.encodeWithSelector(0x095ea7b3, spender, 0))) {
            revert TokenCallFailed(token, 0x095ea7b3);
        }
        if (!_callOptionalReturnBool(token, abi.encodeWithSelector(0x095ea7b3, spender, amount))) {
            revert TokenCallFailed(token, 0x095ea7b3);
        }
    }

    function _callOptionalReturnBool(address token, bytes memory data) private returns (bool) {
        (bool success, bytes memory returndata) = token.call(data);
        return success && (returndata.length == 0 || abi.decode(returndata, (bool)));
    }
}
