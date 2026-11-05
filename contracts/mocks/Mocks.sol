// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 for tests. Returns a bool, like a well-behaved token.
contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A token that returns NOTHING from transfer/transferFrom, the way
///         USDT does. WaspBounty must still work against it.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice Stands in for the ENSv2 PermissionedRegistry.
///
/// Mirrors the real signature exactly — hasRoles(uint256, uint256, address) —
/// and the real semantics we depend on: a role is a single bit in a nybble, and
/// a ROOT_RESOURCE grant satisfies a check on any resource.
contract MockENSRegistry {
    uint256 public constant ROOT_RESOURCE = 0;
    uint256 internal constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;

    error EACInvalidRoleBitmap(uint256 roleBitmap);

    mapping(uint256 => mapping(address => uint256)) public roles;

    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external {
        // the real contract validates this, so the mock must too, or our tests
        // would pass on bitmaps the live registry rejects
        if (roleBitmap & ~ALL_ROLES != 0) revert EACInvalidRoleBitmap(roleBitmap);
        roles[resource][account] |= roleBitmap;
    }

    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external {
        roles[resource][account] &= ~roleBitmap;
    }

    function hasRoles(uint256 anyId, uint256 roleBitmap, address account) external view returns (bool) {
        uint256 effective = roles[ROOT_RESOURCE][account] | roles[anyId][account];
        return effective & roleBitmap == roleBitmap;
    }
}

/// @notice Tries to re-enter resolve() during the refund transfer.
contract ReentrantToken {
    address public target;
    bytes public payload;
    bool public armed;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
        armed = true;
    }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (armed) {
            armed = false;
            (bool ok, ) = target.call(payload);
            require(ok, "reentry blocked");  // we WANT this to fail
        }
        return true;
    }
}
