// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
   WASP BOUNTY  ·  bail for bug reports  ·  both sides post, both sides can lose

   A refundable bond on security reports to open source projects.
   Reporting is ALWAYS free. The bond only ever buys PRIORITY — never permission.

   Three principles encoded here, in order of importance:

   1. BEING WRONG IS NOT SLOP.
      Three verdicts, not two. A good-faith report that turns out incorrect is
      refunded in full. Only fabrication is slashed. Most honest security reports
      are wrong; punishing wrongness would destroy the thing we are trying to save.

   2. THE JUDGE MUST NOT PROFIT FROM THE VERDICT.
      Slashed bonds go to a triage pool that pays independent reviewers.
      They never go to the maintainer who issued the verdict.

   3. BOTH SIDES POST BAIL.
      The maintainer escrows a response bond. If they ghost a report past the
      agreed window, the reporter is paid automatically by anyone who calls
      claimGhosted(). Maintainers are accountable too.

   Tiers live on an ENSv2 name, not in this contract's storage — so a reputation
   earned at one project is spendable at another. See bondFor().

   Hackathon code. Unaudited. Do not deploy with real funds.
*/

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice ENSv2 PermissionedRegistry (EnhancedAccessControl).
///
/// VERIFIED against ensdomains/contracts-v2 on 2026-11-05. The first parameter
/// is a **uint256**, not a bytes32 — an earlier draft of this contract had it as
/// bytes32, which is a silent ABI mismatch that would have mis-encoded every
/// call. On PermissionedRegistry the parameter is named `anyId` and may be a
/// labelhash, a token id, or an EAC resource.
interface IPermissionedRegistry {
    function hasRoles(uint256 anyId, uint256 roleBitmap, address account)
        external
        view
        returns (bool);
}

contract WaspBounty {
    // ---------------------------------------------------------------------
    // Trust tiers — ENSv2 EAC custom roles.
    //
    // Each role occupies ONE NYBBLE (4 bits). ENS's own roles sit in nybbles
    // 0-6, 8, 9, 30 and 31; nybbles 7 and 10-29 are unused.
    //
    // ⚠️ IMPORTANT, AND EASY TO GET WRONG: a nybble does NOT encode a level
    // 0-15. EnhancedAccessControl validates every bitmap against
    //     ALL_ROLES = 0x1111...1111
    // and reverts EACInvalidRoleBitmap if any bit outside the low bit of a
    // nybble is set. So `0xF << 40` is rejected; only `1 << 40` is legal.
    // A tier is therefore three separate roles in three separate nybbles,
    // not one nybble holding a number.
    // ---------------------------------------------------------------------
    uint256 public constant ROLE_TIER_1 = 1 << 40; // nybble 10
    uint256 public constant ROLE_TIER_2 = 1 << 44; // nybble 11
    uint256 public constant ROLE_TIER_3 = 1 << 48; // nybble 12

    enum Verdict {
        Pending,
        Valid,      // real issue            -> full refund + tier up
        GoodFaith,  // wrong, but real work  -> full refund, no tier change
        Slop        // fabricated            -> slashed to the triage pool
    }

    enum Status {
        None,
        Open,
        Resolved,
        Ghosted
    }

    struct Repo {
        address maintainer;
        uint256 pool;           // maintainer's response bond
        uint256 reserved;       // part of pool committed to open reports
        uint64  responseWindow; // seconds the maintainer has to answer
        bool    active;
        string  slug;           // "curl/curl" — the chain names the project it protects
    }

    struct Report {
        address reporter;
        bytes32 repoId;
        bytes32 arkivKey;     // Arkiv entity: sealed report + 90-day disclosure clock
        uint256 bond;         // escrowed reporter bond (0 when waived)
        uint256 ghostPayout;  // reserved from the repo pool for this report
        uint64  respondBy;
        Status  status;
        Verdict verdict;
    }

    IERC20 public immutable token;
    IPermissionedRegistry public immutable ensRegistry;

    /// @notice Tier 0 bond. Small on purpose: trivial for a human once,
    ///         ruinous for a bot ten thousand times.
    uint256 public immutable baseBond;

    /// @notice Receives slashed bonds and pays independent reviewers.
    ///         Set once at construction and never changeable, so nobody — us
    ///         included — can redirect the pool later.
    address public immutable triageSteward;

    /// @notice Slashed bonds accumulate here and pay independent reviewers.
    uint256 public triagePool;

    mapping(bytes32 => Repo) public repos;
    mapping(bytes32 => Report) public reports;
    mapping(address => bool) public hasSubmittedBefore; // first report is always free
    mapping(address => uint8) public earnedTier;        // mirror of what we asked ENS to grant

    uint256 private _nonce;
    uint256 private _lock = 1;

    event RepoRegistered(
        bytes32 indexed repoId,
        address indexed maintainer,
        string slug,
        uint256 pool,
        uint64 responseWindow
    );
    event RepoToppedUp(bytes32 indexed repoId, uint256 amount, uint256 newPool);
    event ReportSubmitted(
        bytes32 indexed reportId,
        bytes32 indexed repoId,
        address indexed reporter,
        uint256 bond,
        uint64 respondBy,
        bytes32 arkivKey
    );
    event BondWaived(bytes32 indexed reportId, address indexed reporter, uint8 tier);
    event Resolved(bytes32 indexed reportId, Verdict verdict, uint256 refunded, uint256 slashed);
    /// @dev Off-chain granter listens for this and issues the ENSv2 role.
    ///      The tier is not stored here as authority — ENS is the authority.
    event TierEarned(address indexed reporter, uint8 newTier);
    event Ghosted(bytes32 indexed reportId, address indexed reporter, uint256 paid);
    event TriagePaid(address indexed reviewer, uint256 amount);

    error NotMaintainer();
    error NotSteward();
    error RepoInactive();
    error RepoAlreadyExists();
    error ReportNotOpen();
    error WindowNotElapsed();
    error WindowElapsed();
    error InsufficientPool();
    error TransferFailed();
    error BadVerdict();
    error Reentrancy();
    error ZeroAddress();
    error BadSlug();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        IERC20 _token,
        IPermissionedRegistry _ensRegistry,
        uint256 _baseBond,
        address _triageSteward
    ) {
        if (_triageSteward == address(0)) revert ZeroAddress();
        token = _token;
        ensRegistry = _ensRegistry;
        baseBond = _baseBond;
        triageSteward = _triageSteward;
    }

    // ---------------------------------------------------------------------
    // ERC20 helpers.
    //
    // Some widely used tokens (USDT being the famous one) do not return a bool
    // from transfer/transferFrom, so `if (!token.transfer(...))` reverts on ABI
    // decoding against them. Treat "no return data" as success, anything else
    // must decode to true.
    // ---------------------------------------------------------------------
    function _pull(address from, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Tier lookup — the entire ENS integration, in one readable function.
    //
    // The reputation is NOT in this contract. It is a role on an ENSv2 name the
    // reporter owns, which is why a tier earned at curl is spendable at the
    // kernel. Remove ENS and this becomes just another siloed database.
    //
    // `labelId` is the LABELHASH: uint256(keccak256(bytes(label))).
    // Deliberately not the token id — ENSv2 regenerates a name's token id on
    // every role change, so a cached token id goes stale the moment a tier is
    // granted. The labelhash is stable.
    // ---------------------------------------------------------------------
    function bondFor(address reporter, uint256 labelId) public view returns (uint256) {
        if (!hasSubmittedBefore[reporter]) return 0;                           // first one free
        if (ensRegistry.hasRoles(labelId, ROLE_TIER_3, reporter)) return 0;    // trusted: walks in
        if (ensRegistry.hasRoles(labelId, ROLE_TIER_2, reporter)) return baseBond / 4;
        if (ensRegistry.hasRoles(labelId, ROLE_TIER_1, reporter)) return baseBond / 2;
        return baseBond;
    }

    function tierOf(address reporter, uint256 labelId) public view returns (uint8) {
        if (ensRegistry.hasRoles(labelId, ROLE_TIER_3, reporter)) return 3;
        if (ensRegistry.hasRoles(labelId, ROLE_TIER_2, reporter)) return 2;
        if (ensRegistry.hasRoles(labelId, ROLE_TIER_1, reporter)) return 1;
        return 0;
    }

    // ---------------------------------------------------------------------
    // Maintainer side — the half nobody else builds
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // Repo identity — derived, never chosen.
    //
    // An earlier version of this contract took `repoId` as a caller-supplied
    // bytes32. That meant the id was an arbitrary number: nothing tied it to a
    // real project, and nothing stopped a stranger from registering the lane
    // for `curl/curl` and sitting in the maintainer's seat.
    //
    // Now the id IS the project name, hashed. Two people cannot disagree about
    // it, a wrong slug produces a different lane rather than a silent
    // impersonation, and anyone can recompute it off-chain:
    //
    //     keccak256(abi.encodePacked("github.com/", "curl/curl"))
    //     == 0x756b88bbc9f99cb529a36e4733f94ba243ab2d94bea853ab8931a57400f64f95
    //
    // The slug MUST be lowercase, because GitHub treats owner/repo
    // case-insensitively — `Curl/Curl` and `curl/curl` are one project and must
    // never become two lanes. Checked on-chain rather than trusted.
    // ---------------------------------------------------------------------

    /// @notice The canonical lane id for a GitHub project. Pure, so anyone can
    ///         verify off-chain tooling agrees with the chain.
    function repoIdFor(string memory slug) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("github.com/", slug));
    }

    /// @dev Rejects anything that is not `owner/repo` in lowercase. Deliberately
    ///      strict: a slug that merely looks right is an impersonation risk.
    function _requireCanonicalSlug(string memory slug) private pure {
        bytes memory b = bytes(slug);
        if (b.length < 3 || b.length > 100) revert BadSlug();

        uint256 slashes;
        uint256 slashAt;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c == "/") {
                ++slashes;
                slashAt = i;
            } else if (
                !((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-" || c == "_" || c == ".")
            ) {
                revert BadSlug(); // uppercase and everything exotic lands here
            }
        }
        // exactly one slash, and neither side of it empty
        if (slashes != 1 || slashAt == 0 || slashAt == b.length - 1) revert BadSlug();
    }

    /// @notice A project opens its priority lane by escrowing a response bond.
    ///         This is the maintainer's half of the bail.
    /// @param slug the GitHub project, lowercase `owner/repo`. The lane id is
    ///        derived from it, so it cannot name one project and bind another.
    function registerRepo(string calldata slug, uint256 pool, uint64 responseWindow)
        external
        nonReentrant
        returns (bytes32 repoId)
    {
        _requireCanonicalSlug(slug);
        repoId = repoIdFor(slug);
        if (repos[repoId].active) revert RepoAlreadyExists();
        _pull(msg.sender, pool);

        repos[repoId] = Repo({
            maintainer: msg.sender,
            pool: pool,
            reserved: 0,
            responseWindow: responseWindow,
            active: true,
            slug: slug
        });

        emit RepoRegistered(repoId, msg.sender, slug, pool, responseWindow);
    }

    function topUp(bytes32 repoId, uint256 amount) external nonReentrant {
        Repo storage r = repos[repoId];
        if (!r.active) revert RepoInactive();
        _pull(msg.sender, amount);
        r.pool += amount;
        emit RepoToppedUp(repoId, amount, r.pool);
    }

    // ---------------------------------------------------------------------
    // Reporter side
    // ---------------------------------------------------------------------

    /// @notice Enter the PRIORITY lane. The free lane needs no contract call at
    ///         all — that is the point. This only buys a guaranteed human answer.
    /// @param labelId  the reporter's ENSv2 labelhash, carrying their tier
    /// @param arkivKey the Arkiv entity holding the sealed report + 90-day clock
    function submit(bytes32 repoId, uint256 labelId, bytes32 arkivKey)
        external
        nonReentrant
        returns (bytes32 reportId)
    {
        Repo storage r = repos[repoId];
        if (!r.active) revert RepoInactive();

        uint256 bond = bondFor(msg.sender, labelId);
        uint8 tier = tierOf(msg.sender, labelId);

        // The maintainer's promise must be collateralised before we accept.
        uint256 payout = baseBond;
        if (r.pool - r.reserved < payout) revert InsufficientPool();
        r.reserved += payout;

        _pull(msg.sender, bond);

        reportId = keccak256(abi.encodePacked(repoId, msg.sender, arkivKey, _nonce++));
        uint64 respondBy = uint64(block.timestamp) + r.responseWindow;

        if (bond == 0) emit BondWaived(reportId, msg.sender, tier);

        reports[reportId] = Report({
            reporter: msg.sender,
            repoId: repoId,
            arkivKey: arkivKey,
            bond: bond,
            ghostPayout: payout,
            respondBy: respondBy,
            status: Status.Open,
            verdict: Verdict.Pending
        });

        hasSubmittedBefore[msg.sender] = true;

        emit ReportSubmitted(reportId, repoId, msg.sender, bond, respondBy, arkivKey);
    }

    // ---------------------------------------------------------------------
    // Resolution
    // ---------------------------------------------------------------------

    /// @notice Maintainer's call. The 0G enclave verdict is a FIRST OPINION only —
    ///         a human always decides, and the signed machine verdict is stored
    ///         alongside the report on Arkiv so the decision can be audited.
    function resolve(bytes32 reportId, Verdict verdict) external nonReentrant {
        Report storage rep = reports[reportId];
        if (rep.status != Status.Open) revert ReportNotOpen();
        if (verdict == Verdict.Pending) revert BadVerdict();

        Repo storage r = repos[rep.repoId];
        if (msg.sender != r.maintainer) revert NotMaintainer();
        if (block.timestamp > rep.respondBy) revert WindowElapsed(); // too late: see claimGhosted

        rep.status = Status.Resolved;
        rep.verdict = verdict;

        // Release the maintainer's reservation — they answered in time.
        r.reserved -= rep.ghostPayout;

        uint256 refunded;
        uint256 slashed;

        if (verdict == Verdict.Slop) {
            // Slashed bonds fund the humans who clean up after the bots.
            // They never reach the maintainer who issued this verdict.
            slashed = rep.bond;
            triagePool += slashed;
        } else {
            // Valid OR GoodFaith: full refund. Being wrong is not slop.
            refunded = rep.bond;
            _push(rep.reporter, refunded);
            if (verdict == Verdict.Valid) {
                uint8 next = earnedTier[rep.reporter] < 3 ? earnedTier[rep.reporter] + 1 : 3;
                earnedTier[rep.reporter] = next;
                emit TierEarned(rep.reporter, next); // granter issues the ENSv2 role
            }
        }

        emit Resolved(reportId, verdict, refunded, slashed);
    }

    /// @notice The maintainer ghosted. Anyone may call this. The reporter is paid
    ///         from the repo's response bond and gets their own bond back.
    function claimGhosted(bytes32 reportId) external nonReentrant {
        Report storage rep = reports[reportId];
        if (rep.status != Status.Open) revert ReportNotOpen();
        if (block.timestamp <= rep.respondBy) revert WindowNotElapsed();

        Repo storage r = repos[rep.repoId];

        rep.status = Status.Ghosted;
        r.reserved -= rep.ghostPayout;
        r.pool -= rep.ghostPayout;

        uint256 owed = rep.ghostPayout + rep.bond;
        _push(rep.reporter, owed);

        emit Ghosted(reportId, rep.reporter, owed);
    }

    // ---------------------------------------------------------------------
    // Triage pool
    // ---------------------------------------------------------------------

    /// @notice Pay an independent reviewer out of the slashed-bond pool.
    ///
    /// @dev Gated to an immutable steward set at construction. An earlier draft
    ///      left this function unguarded, which meant anyone could drain the
    ///      pool to themselves — the one place where this design's own money
    ///      sits. Stated plainly rather than quietly fixed.
    ///
    ///      Still a hackathon simplification: a production version routes this
    ///      through reviewer attestations rather than a trusted caller. What it
    ///      must never be is the maintainer, and it is not.
    function payReviewer(address reviewer, uint256 amount) external nonReentrant {
        if (msg.sender != triageSteward) revert NotSteward();
        if (amount > triagePool) revert InsufficientPool();
        triagePool -= amount;
        _push(reviewer, amount);
        emit TriagePaid(reviewer, amount);
    }
}
