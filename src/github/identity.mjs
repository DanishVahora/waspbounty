/* ============================================================================
   WHO OWNS THIS REPO, AND WHO IS THIS REPORTER?
   ----------------------------------------------------------------------------
   WHY THIS FILE IS THE MISSING HALF

   WaspBounty's contract takes a `bytes32 repoId`. Until now that was an
   arbitrary number: nothing said it was a real project, and nothing stopped
   anyone from registering the bounty lane for `curl/curl` and taking the
   maintainer's seat. The Arkiv schema carried `repo: "curl/curl"` as a
   DECORATIVE STRING.

   A bounty programme whose repo identity is unverified is a bounty programme
   for a repo you do not control. So the id is now derived, not chosen:

       repoId = keccak256("github.com/" + lowercase(owner/repo))

   Anyone can recompute it. Two people cannot disagree about it. And a wrong
   slug produces a different id rather than a silent impersonation.

   HOW CONTROL IS PROVED — AND WHAT THE PROOF ACTUALLY MEANS

   The maintainer commits one file to their default branch:

       .well-known/waspbounty.txt   containing their wallet address

   We read it from raw.githubusercontent.com. That means:
     - no OAuth, no app install, no permission grant from the maintainer
     - no API token, so no rate limit on the verification path
     - a judge can check it with ONE curl and no account

   Be precise about what this establishes: it proves SOMEONE WITH PUSH ACCESS TO
   THE DEFAULT BRANCH published that address. That is not "proof of ownership" --
   it is proof of exactly the authority that matters here, because the person who
   can merge the fix is the person who should hold the response bond. Anyone who
   loses push access loses the ability to re-point it, which is the correct
   failure mode.

   Deliberately the same shape as DNS TXT domain validation. Boring, auditable,
   and nobody has to trust us.
   ========================================================================= */

import { keccak256, stringToHex } from "viem";

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";

/* A token lifts the API from 60 req/hr to 5,000. The VERIFICATION path never
   needs one -- only the signals path does. Optional on purpose. */
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

export class GitHubError extends Error {}

export const PROOF_PATH = ".well-known/waspbounty.txt";

/** GitHub treats owner/repo case-insensitively, so `Curl/Curl` and `curl/curl`
    are one project and MUST produce one id. Canonicalise before hashing. */
export function canonicalSlug(slug) {
  const s = String(slug ?? "")
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(s);
  if (!m) throw new GitHubError(`not an owner/repo slug: ${JSON.stringify(slug)}`);
  return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
}

/** The on-chain id. Namespaced by host so a future GitLab lane cannot collide. */
export function repoIdFor(slug) {
  return keccak256(stringToHex(`github.com/${canonicalSlug(slug)}`));
}

async function gh(path) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "waspbounty" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return null;
  if (r.status === 403 || r.status === 429) {
    throw new GitHubError("GitHub rate limit reached - set GITHUB_TOKEN to lift 60/hr to 5,000/hr");
  }
  if (!r.ok) throw new GitHubError(`GitHub API ${r.status} on ${path}`);
  return r.json();
}

/** Does this project exist, and what is its default branch? */
export async function repoExists(slug) {
  const canonical = canonicalSlug(slug);
  const data = await gh(`/repos/${canonical}`);
  if (!data) return { exists: false, slug: canonical };
  return {
    exists: true,
    slug: data.full_name.toLowerCase(),
    displaySlug: data.full_name,
    defaultBranch: data.default_branch,
    archived: data.archived,
    fork: data.fork,
  };
}

/* An address is 20 bytes of hex. Compare case-insensitively -- a maintainer who
   types their address in lowercase has still proved the same thing. */
const ADDRESS = /0x[0-9a-fA-F]{40}/g;

/**
 * Prove control of a repo's default branch by reading the committed proof file.
 *
 * Uses raw.githubusercontent.com, NOT the API: unauthenticated, unmetered and
 * reproducible by a judge with
 *
 *   curl https://raw.githubusercontent.com/OWNER/REPO/HEAD/.well-known/waspbounty.txt
 */
export async function verifyRepoControl(slug, address, { branch = "HEAD" } = {}) {
  const canonical = canonicalSlug(slug);
  const want = String(address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) throw new GitHubError("address must be 20 bytes of hex");

  const url = `${RAW}/${canonical}/${branch}/${PROOF_PATH}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { verified: false, reason: `could not reach raw.githubusercontent.com: ${e.message}`, url };
  }

  if (res.status === 404) {
    return {
      verified: false,
      reason: `no ${PROOF_PATH} on the default branch`,
      url,
      /* tell them exactly how to fix it rather than just failing */
      howToFix: `commit a file at ${PROOF_PATH} containing ${address}`,
      repoId: repoIdFor(canonical),
    };
  }
  if (!res.ok) return { verified: false, reason: `raw.githubusercontent.com returned ${res.status}`, url };

  /* Cap the read. A proof file is about 42 bytes; anything large is not a proof
     and should not be pulled into memory on an unauthenticated path. */
  const text = (await res.text()).slice(0, 4096);
  const found = [...text.matchAll(ADDRESS)].map((m) => m[0].toLowerCase());

  if (!found.includes(want)) {
    return {
      verified: false,
      reason: found.length
        ? `${PROOF_PATH} names a different address (${found[0]})`
        : `${PROOF_PATH} contains no address`,
      url,
      repoId: repoIdFor(canonical),
    };
  }

  return {
    verified: true,
    slug: canonical,
    repoId: repoIdFor(canonical),
    address: want,
    url,
    /* the whole point: anyone can repeat this without us */
    howToCheck: `curl ${url}`,
    proves: "someone with push access to the default branch published this address",
  };
}

/**
 * Prove a reporter controls a GitHub account, via a PUBLIC GIST they own.
 *
 * Why a gist and not an OAuth login: the tier has to be checkable by a stranger
 * later, long after any session ended. A public gist is a permanent, publicly
 * readable statement by that account. OAuth would prove it to US and nobody else.
 */
export async function verifyUserControl(handle, address) {
  const user = String(handle ?? "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9-]{1,39}$/.test(user)) throw new GitHubError(`not a GitHub handle: ${JSON.stringify(handle)}`);
  const want = String(address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) throw new GitHubError("address must be 20 bytes of hex");

  const gists = await gh(`/users/${user}/gists?per_page=100`);
  if (!gists) return { verified: false, reason: `no such GitHub user: ${user}` };

  for (const g of gists) {
    const file = Object.values(g.files ?? {}).find(
      (f) => /waspbounty/i.test(f.filename ?? "") && (f.size ?? 0) < 4096,
    );
    if (!file?.raw_url) continue;
    try {
      const r = await fetch(file.raw_url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const found = [...(await r.text()).slice(0, 4096).matchAll(ADDRESS)].map((m) => m[0].toLowerCase());
      if (found.includes(want)) {
        return {
          verified: true,
          handle: user,
          address: want,
          gistId: g.id,
          gistUrl: g.html_url,
          createdAt: g.created_at,
          howToCheck: `curl ${file.raw_url}`,
        };
      }
    } catch { /* try the next gist rather than failing the whole check */ }
  }

  return {
    verified: false,
    reason: `no public gist of ${user} names ${want}`,
    howToFix: `gh gist create --public waspbounty.txt   (containing ${address})`,
  };
}
