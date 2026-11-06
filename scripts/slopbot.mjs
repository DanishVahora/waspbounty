/* ============================================================================
   slopbot — Act 1 of the demo: the problem, at volume.
   ----------------------------------------------------------------------------
   In January 2026 curl closed its HackerOne bounty after an 8x surge in
   AI-generated vulnerability reports. OpenSSF puts human triage at 2-8 hours per
   report. That arithmetic is the whole pitch: one person with an API key spends
   sixty seconds and costs a maintainer a month.

   This script IS that person. It files N fabricated-but-plausible reports at a
   repo over a window you choose, so the camera can watch them land in silence —
   no bond, no cost, nothing in the way.

   Three rules this file holds itself to:

     1. PLAUSIBLE, NOT RANDOM. Reports are assembled per SUBSYSTEM, never from
        independent pools: the file, the function, the caller, the artifact and
        the reproduction line all come from the same bundle, so nothing reads as
        mismatched scenery. Release numbers are real and CVSS vectors score to
        the number printed next to them. Noise would prove nothing — the point
        of Act 1 is that a maintainer cannot tell at a glance.

     2. FABRICATED, AND PROVABLY SO. Every report names a function that does not
        exist. Most also cite a line past the end of the file, or describe a
        mechanism that contradicts itself (a stack buffer corrupting the heap).
        Those are exactly the three tells the enclave triage prompt works from
        (src/triage/zerog.mjs), so Act 2 has something real to find.

     3. NEVER MISTAKEN FOR A REAL REPORT. Every one carries synthetic: true, a
        caseId prefixed wb-slop-, and an x-wasp-synthetic header. Grep any of the
        three and the whole flood is accounted for. It deliberately does NOT set
        `simulated`, which in this app means "a labelled stand-in for live data"
        — these are not stand-ins for anything.

   Usage:
     node scripts/slopbot.mjs --repo curl/curl --count 20 --over 60 --dry
     node scripts/slopbot.mjs --repo openssl/openssl --count 20 --over 60
     node scripts/slopbot.mjs --seed 3f9c21      replays an identical flood, so a
                                                 second take matches the first

   Flags:
     --repo <owner/name>   target project          (default curl/curl)
     --count <n>           how many reports        (default 20)
     --over <seconds>      window to spread across (default 60; 0 = flat out)
     --url <base>          app base URL            (default http://localhost:4318)
     --path <pathname>     POST route              (default /api/triage)
     --lane free|priority|mix                      (default free)
     --seed <hex>          reproduce an earlier run
     --dry                 print, send nothing
   ========================================================================= */

import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

/* ---- CLI ------------------------------------------------------------------
   Same shape as the other scripts here: argv scanned by hand, no parser dep. */
const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const flag = (n, dflt) => {
  const i = argv.indexOf("--" + n);
  return i === -1 || i === argv.length - 1 ? dflt : argv[i + 1];
};

/* Without this, `--help` would fall through to the defaults and actually file
   twenty reports at the running app. An unrecognised flag is cheap to print. */
if (has("help") || has("h")) {
  console.log([
    "",
    "  slopbot — file N fabricated-but-plausible reports at a repo, paced for camera.",
    "",
    "    --repo <owner/name>   target project          (default curl/curl)",
    "    --count <n>           how many reports        (default 20)",
    "    --over <seconds>      window to spread across (default 60; 0 = flat out)",
    "    --url <base>          app base URL            (default http://localhost:4318)",
    "    --path <pathname>     POST route              (default /api/triage)",
    "    --lane free|priority|mix                      (default free)",
    "    --seed <hex>          reproduce an earlier run",
    "    --dry                 print, send nothing",
    "",
    "  Profiled repos: curl/curl, openssl/openssl, nodejs/node, python/cpython,",
    "  ffmpeg/ffmpeg. Anything else gets generic paths and says so.",
    "",
  ].join("\n"));
  process.exit(0);
}

const REPO = String(flag("repo", "curl/curl"))
  .replace(/^https?:\/\/(www\.)?github\.com\//, "")
  .replace(/\.git$/, "")
  .replace(/\/+$/, "");
const COUNT = Math.max(1, Math.min(500, Number(flag("count", 20)) || 20));
const OVER = Math.max(0, Number(flag("over", 60)) || 0);
const BASE = String(flag("url", "http://localhost:4318")).replace(/\/+$/, "");
const ROUTE = String(flag("path", "/api/triage")).replace(/^(?!\/)/, "/");
const LANE = ["free", "priority", "mix"].includes(String(flag("lane", "free")))
  ? String(flag("lane", "free"))
  : "free";
const DRY = has("dry");

if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) {
  console.error("slopbot: --repo must look like owner/name, got: " + REPO);
  process.exit(1);
}

/* ---- seeded randomness ----------------------------------------------------
   Seeded on purpose. Re-shooting Act 1 with a different set of reports would
   mean re-cutting the voiceover, so --seed replays the exact same flood.
   mulberry32 is four lines, and we need "varied", not cryptographic. */
const SEED = String(flag("seed", randomBytes(3).toString("hex")));
const seedInt = /^[0-9a-f]+$/i.test(SEED)
  ? parseInt(SEED, 16) >>> 0
  : [...SEED].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7) >>> 0;

let rngState = seedInt || 1;
const rnd = () => {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.min(a.length - 1, Math.floor(rnd() * a.length))];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p) => rnd() < p;
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");

/* ============================================================================
   PROJECT PROFILES
   ----------------------------------------------------------------------------
   The plausibility lives here. A slop report convinces because the scenery is
   real: the file exists, the caller exists, the release shipped. Only the
   function in the middle is invented — which is how the real ones read.

   Each profile is a list of SUBSYSTEMS, and a report never mixes two. That is
   the difference between "looks like work" and "looks generated": a reader who
   knows curl will forgive an unfamiliar helper in lib/ftp.c, but not an FTP
   helper reached from curl_url_set().

     file / lines  real path, approximate length. The length only has to be LOW
                   enough that a multiple of it is past the end of the file — we
                   are manufacturing a tell, not measuring, so an approximation
                   is the honest thing to store.
     fns           INVENTED, spelled the way the project spells its internals
                   (curl exports helpers as Curl_*, OpenSSL as ossl_*, CPython
                   as _Py*). A reader who knows the codebase has to grep to be
                   sure. That is the point.
     callers       REAL entry points. An invented callee hanging off a real
                   caller is the most convincing move available, so every
                   report makes it.
     topics        gates classes that only make sense here (crypto).
   ========================================================================= */
const PROFILES = {
  "curl/curl": {
    product: "curl", lang: "C", syntax: "c", issueBase: 9200,
    build: "a default build (--with-openssl, FTP and HTTP/3 enabled)",
    released: ["7.88.1", "8.0.1", "8.1.2", "8.4.0", "8.5.0", "8.7.1", "8.9.1", "8.11.1", "8.12.1"],
    unreleased: ["8.19.0", "9.1.0"],
    subsystems: [
      { file: "lib/ftp.c", lines: 4600, kind: "native",
        fns: ["Curl_ftp_resp_bufgrow", "ftp_pasv_reply_copy", "ftp_state_mlsd_parse"],
        callers: ["ftp_statemach_act", "Curl_pretransfer", "curl_easy_perform"],
        artifacts: ["PASV reply", "227 response line", "MLSD listing"],
        pocs: ["curl -v --ftp-pasv ftp://attacker.example/pub/"] },

      { file: "lib/http.c", lines: 4500, kind: "native",
        fns: ["Curl_http_hdr_normalize", "http_hdr_fold_continuation", "Curl_http_trailer_collect"],
        callers: ["Curl_http", "Curl_http_readwrite_headers", "curl_easy_perform"],
        artifacts: ["response header", "chunked trailer", "Location header"],
        pocs: ["curl -v -L https://attacker.example/redirect"] },

      { file: "lib/cookie.c", lines: 1900, kind: "native",
        fns: ["Curl_cookie_parse_secure", "cookie_domain_match_wild", "Curl_cookie_jar_merge"],
        callers: ["Curl_cookie_add", "Curl_http", "curl_easy_perform"],
        artifacts: ["Set-Cookie header", "cookie jar line", "domain attribute"],
        pocs: ["curl -v -c jar.txt https://attacker.example/set-cookie"] },

      { file: "lib/urlapi.c", lines: 2100, kind: "native",
        fns: ["Curl_urlapi_host_canon", "urlapi_decode_authority", "Curl_url_zone_strip"],
        callers: ["curl_url_set", "curl_url_get", "Curl_parse_login_details"],
        artifacts: ["userinfo field", "IPv6 zone identifier", "percent-encoded host"],
        pocs: ["curl -v 'https://user:pass@[fe80::1%25eth0]/'"] },

      { file: "lib/vtls/openssl.c", lines: 5300, kind: "native", topics: ["crypto"],
        fns: ["Curl_vtls_session_reuse_check", "ossl_verify_hostname_fast", "Curl_ssl_sessionid_cmp"],
        callers: ["Curl_ssl_connect", "Curl_ssl_getsessionid", "curl_easy_perform"],
        artifacts: ["server certificate", "session ticket", "ALPN extension"],
        pocs: ["curl -v --tlsv1.3 https://attacker.example/"] },

      { file: "lib/vquic/curl_ngtcp2.c", lines: 2600, kind: "native",
        fns: ["Curl_h3_hdr_table_grow", "ngtcp2_stream_recv_copy", "Curl_h3_settings_merge"],
        callers: ["Curl_conn_recv", "multi_runsingle", "curl_easy_perform"],
        artifacts: ["HTTP/3 SETTINGS frame", "QPACK encoder stream", "CRYPTO frame"],
        pocs: ["curl -v --http3 https://attacker.example/"] },

      { file: "lib/content_encoding.c", lines: 1200, kind: "native",
        fns: ["Curl_content_decode_chunk", "zlib_inflate_grow", "Curl_unencode_brotli_write"],
        callers: ["Curl_client_write", "Curl_http_readwrite_headers", "curl_easy_perform"],
        artifacts: ["Content-Encoding header", "gzip stream", "brotli stream"],
        pocs: ["curl -v --compressed https://attacker.example/payload.gz"] },

      { file: "lib/ws.c", lines: 1500, kind: "native",
        fns: ["Curl_ws_frame_reassemble", "ws_dec_frame_copy", "Curl_ws_mask_apply"],
        callers: ["curl_ws_recv", "Curl_ws_accept", "curl_easy_perform"],
        artifacts: ["WebSocket continuation frame", "masked payload", "close frame"],
        pocs: ["curl -v --no-buffer wss://attacker.example/socket"] },

      { file: "lib/socks.c", lines: 1200, kind: "native",
        fns: ["Curl_socks5_greet_parse", "socks5_resolve_copy"],
        callers: ["Curl_SOCKS5", "Curl_connect", "curl_easy_perform"],
        artifacts: ["SOCKS5 greeting", "method selection reply", "bound address reply"],
        pocs: ["curl -v --socks5 attacker.example:1080 https://example.com/"] },

      { file: "lib/doh.c", lines: 1500, kind: "native",
        fns: ["Curl_doh_probe_decode", "doh_rdata_copy"],
        callers: ["Curl_resolv", "Curl_doh", "curl_easy_perform"],
        artifacts: ["DoH response", "DNS RDATA field", "CNAME chain"],
        pocs: ["curl -v --doh-url https://attacker.example/dns-query https://example.com/"] },
    ],
  },

  "openssl/openssl": {
    product: "OpenSSL", lang: "C", syntax: "c", issueBase: 24800,
    build: "./config with default options plus enable-quic",
    released: ["1.1.1w", "3.0.13", "3.1.5", "3.2.1", "3.3.2", "3.4.0"],
    unreleased: ["3.9.0", "4.1.0"],
    subsystems: [
      { file: "ssl/statem/statem_srvr.c", lines: 4100, kind: "native", topics: ["crypto"],
        fns: ["tls13_derive_early_secret_ex", "ssl_scan_clienthello_exts", "tls_parse_ctos_psk_fast"],
        callers: ["SSL_accept", "SSL_do_handshake", "SSL_read"],
        artifacts: ["ClientHello extension", "PSK binder", "session ticket"],
        pocs: ["openssl s_server -tls1_3 -cert server.pem -accept 4433"] },

      { file: "ssl/record/rec_layer_s3.c", lines: 1800, kind: "native",
        fns: ["ossl_record_layer_pad_check", "ssl3_read_n_grow"],
        callers: ["SSL_read", "SSL_peek", "SSL_do_handshake"],
        artifacts: ["TLS record", "padding block", "ChangeCipherSpec message"],
        pocs: ["openssl s_client -connect attacker.example:443 -tls1_2"] },

      { file: "crypto/rsa/rsa_ossl.c", lines: 1000, kind: "native", topics: ["crypto"],
        fns: ["ossl_rsa_blinding_restore", "rsa_ossl_mod_exp_fast"],
        callers: ["RSA_private_decrypt", "EVP_PKEY_decrypt", "SSL_do_handshake"],
        artifacts: ["PKCS#1 padded block", "blinding parameter", "private exponent"],
        pocs: ["openssl rsautl -decrypt -inkey key.pem -in crafted.bin"] },

      { file: "crypto/bn/bn_exp.c", lines: 1500, kind: "native", topics: ["crypto"],
        fns: ["ossl_bn_mod_exp_consttime2", "bn_window_grow"],
        callers: ["BN_mod_exp", "RSA_private_decrypt", "DH_compute_key"],
        artifacts: ["exponent", "modulus", "DH public value"],
        pocs: ["openssl dhparam -check -in crafted.pem"] },

      { file: "crypto/asn1/tasn_dec.c", lines: 1200, kind: "native",
        fns: ["asn1_item_embed_d2i_fast", "asn1_template_ex_d2i_grow"],
        callers: ["d2i_X509", "d2i_PKCS7", "X509_verify_cert"],
        artifacts: ["ASN.1 SEQUENCE", "nested OPTIONAL field", "indefinite-length encoding"],
        pocs: ["openssl asn1parse -inform der -in crafted.der"] },

      { file: "crypto/x509/x509_cmp.c", lines: 600, kind: "native",
        fns: ["ossl_x509_name_cmp_nocase", "x509_name_hash_fast"],
        callers: ["X509_verify_cert", "X509_NAME_cmp", "SSL_get1_peer_certificate"],
        artifacts: ["certificate chain", "subject DN", "issuer DN"],
        pocs: ["openssl verify -CAfile chain.pem crafted.pem"] },

      { file: "crypto/evp/e_aes.c", lines: 4000, kind: "native", topics: ["crypto"],
        fns: ["ossl_aes_gcm_tls_cipher_ex", "aes_gcm_ctrl_setiv_fast"],
        callers: ["EVP_DecryptUpdate", "EVP_CIPHER_CTX_ctrl", "SSL_read"],
        artifacts: ["GCM nonce", "AEAD tag", "TLS 1.3 record"],
        pocs: ["openssl s_client -connect attacker.example:443 -cipher ECDHE-RSA-AES256-GCM-SHA384"] },

      { file: "ssl/quic/quic_rx_depack.c", lines: 1700, kind: "native",
        fns: ["ossl_quic_rxfc_window_grow", "quic_depack_crypto_frame_fast"],
        callers: ["SSL_read", "SSL_do_handshake", "SSL_handle_events"],
        artifacts: ["QUIC CRYPTO frame", "ACK frame", "NEW_TOKEN frame"],
        pocs: ["openssl s_client -quic -connect attacker.example:443"] },
    ],
  },

  "nodejs/node": {
    product: "Node.js", lang: "C++ and JavaScript", syntax: "js", issueBase: 54100,
    build: "any release build with the default V8 flags",
    released: ["18.19.1", "20.11.1", "20.18.0", "22.5.1", "22.11.0", "24.1.0"],
    unreleased: ["26.3.0", "28.0.0"],
    subsystems: [
      { file: "src/node_http_parser.cc", lines: 1200, kind: "native",
        fns: ["ParseHeaderValueUnsafe", "OnHeaderValueGrow"],
        callers: ["http.createServer", "http.request", "server.on('request')"],
        artifacts: ["Transfer-Encoding header", "header value over 16 KB", "chunk extension"],
        pocs: ["curl -X POST --data-binary @payload.bin http://localhost:8080/"] },

      { file: "src/node_buffer.cc", lines: 1400, kind: "native",
        fns: ["ByteLengthUtf8Fast", "BufferCopyUnchecked"],
        callers: ["Buffer.from", "buf.copy", "buf.write"],
        artifacts: ["Buffer view", "UTF-8 surrogate pair", "typed array offset"],
        pocs: ["node -e 'Buffer.from(p).copy(t, 0, 0, 1e9)'"] },

      { file: "src/node_zlib.cc", lines: 1300, kind: "native",
        fns: ["ZlibInflateGrowBuffer", "ZlibWriteSyncUnchecked"],
        callers: ["zlib.inflateSync", "zlib.createGunzip", "stream.pipeline"],
        artifacts: ["inflate stream", "deflate dictionary", "gzip trailer"],
        pocs: ["node -e 'require(\"zlib\").inflateSync(fs.readFileSync(\"payload.bin\"))'"] },

      { file: "src/crypto/crypto_cipher.cc", lines: 1100, kind: "native", topics: ["crypto"],
        fns: ["CipherUpdateInPlace", "GetAuthTagFast"],
        callers: ["crypto.createCipheriv", "cipher.update", "decipher.setAuthTag"],
        artifacts: ["GCM auth tag", "IV shorter than the block size", "AAD buffer"],
        pocs: ["node -e 'crypto.createDecipheriv(\"aes-256-gcm\", k, iv).setAuthTag(tag)'"] },

      { file: "lib/internal/url.js", lines: 2100, kind: "script",
        fns: ["normalizeSearchParamsUnsafe", "parseHostFast"],
        callers: ["new URL", "url.parse", "fetch"],
        artifacts: ["URL with a 70 KB host", "percent-encoded authority", "IPv6 zone identifier"],
        pocs: ["node -e 'new URL(\"http://\" + \"a\".repeat(70000))'"] },

      { file: "lib/internal/modules/esm/resolve.js", lines: 1200, kind: "script",
        fns: ["resolveExportsTargetFast", "packageImportsResolveUnsafe"],
        callers: ["import()", "require", "createRequire"],
        artifacts: ["package exports map", "imports field", "self-referencing specifier"],
        pocs: ["node --experimental-loader ./evil-loader.mjs app.mjs"] },

      { file: "lib/internal/fs/utils.js", lines: 1000, kind: "script",
        fns: ["getValidatedPathUnsafe", "normalizePathSegments"],
        callers: ["fs.promises.readFile", "fs.createWriteStream", "fs.cpSync"],
        artifacts: ["path with a NUL byte", "symlinked destination", "../ segment"],
        pocs: ["node -e 'fs.cpSync(\"evil\", \"/tmp/out\", { recursive: true })'"] },

      { file: "lib/internal/http2/core.js", lines: 3400, kind: "script",
        fns: ["http2SettingsMerge", "mapToHeadersFast"],
        callers: ["http2.createServer", "session.request", "stream.respond"],
        artifacts: ["HTTP/2 SETTINGS frame", "HPACK header block", "PRIORITY frame"],
        pocs: ["node -e 'require(\"http2\").connect(\"http://localhost:8443\")'"] },
    ],
  },

  "python/cpython": {
    product: "CPython", lang: "C and Python", syntax: "py", issueBase: 118300,
    build: "a stock ./configure build (no --with-pydebug)",
    released: ["3.9.18", "3.10.13", "3.11.9", "3.12.4", "3.13.0"],
    unreleased: ["3.15.1", "4.0.0"],
    subsystems: [
      { file: "Objects/bytearrayobject.c", lines: 1300, kind: "native",
        fns: ["bytearray_resize_exact", "bytearray_extend_fast"],
        callers: ["bytearray.extend", "bytearray.__iadd__", "bytes.join"],
        artifacts: ["2 GB iterable", "iterator with a false __length_hint__", "memoryview source"],
        pocs: ["python3 -c 'b=bytearray(); b.extend(FakeLen())'"] },

      { file: "Modules/_pickle.c", lines: 7800, kind: "native",
        fns: ["pickle_load_long_fast", "load_counted_binbytes_grow"],
        callers: ["pickle.loads", "pickle.load", "copy.deepcopy"],
        artifacts: ["pickle stream", "BINBYTES opcode declaring 4 GB", "memo reference"],
        pocs: ["python3 -c 'import pickle; pickle.loads(open(\"p.bin\",\"rb\").read())'"] },

      { file: "Objects/unicodeobject.c", lines: 12000, kind: "native",
        fns: ["_PyUnicode_WidenToUCS4Unsafe", "unicode_decode_utf8_fast"],
        callers: ["str.encode", "bytes.decode", "str.translate"],
        artifacts: ["lone high surrogate", "UTF-8 surrogate pair", "code point above U+10FFFF"],
        pocs: ["python3 -c 'b\"\\xed\\xa0\\x80\".decode(\"utf-8\", \"surrogatepass\")'"] },

      { file: "Modules/socketmodule.c", lines: 7500, kind: "native",
        fns: ["sock_recvfrom_into_locked", "sock_sendmsg_iov_grow"],
        callers: ["socket.recvfrom_into", "socket.sendmsg", "socket.recv_into"],
        artifacts: ["sockaddr longer than the buffer", "iovec array", "control message"],
        pocs: ["python3 -c 's.recvfrom_into(bytearray(8), 4096)'"] },

      { file: "Modules/_ssl.c", lines: 6300, kind: "native", topics: ["crypto"],
        fns: ["_ssl_read_into_locked", "ssl_verify_hostname_fast"],
        callers: ["ssl.SSLSocket.recv_into", "ssl.SSLContext.wrap_socket", "ssl.get_server_certificate"],
        artifacts: ["server certificate", "SAN entry with a NUL byte", "session ticket"],
        pocs: ["python3 -c 'import ssl; ssl.get_server_certificate((\"attacker.example\", 443))'"] },

      { file: "Lib/tarfile.py", lines: 2900, kind: "script",
        fns: ["_sanitize_member_path", "_extract_member_unchecked"],
        callers: ["tarfile.extractall", "tarfile.open", "shutil.unpack_archive"],
        artifacts: ["tar member with a long name", "PAX header", "symlink member"],
        pocs: ["python3 -c 'import tarfile; tarfile.open(\"evil.tar\").extractall(\"/tmp/x\")'"] },

      { file: "Lib/zipfile/__init__.py", lines: 2900, kind: "script",
        fns: ["_resolve_zip_member", "_read_end_record_fast"],
        callers: ["zipfile.ZipFile.extract", "zipfile.ZipFile.extractall", "shutil.unpack_archive"],
        artifacts: ["zip central directory", "member name with ../", "zip64 extra field"],
        pocs: ["python3 -c 'import zipfile; zipfile.ZipFile(\"evil.zip\").extractall(\"/tmp/x\")'"] },

      { file: "Lib/http/client.py", lines: 1600, kind: "script",
        fns: ["_parse_content_range", "_read_chunked_unsafe"],
        callers: ["http.client.HTTPConnection.getresponse", "urllib.request.urlopen", "requests.get"],
        artifacts: ["Content-Range header", "chunked response", "Content-Length with a leading plus"],
        pocs: ["python3 -c 'import urllib.request; urllib.request.urlopen(\"http://attacker.example/\")'"] },
    ],
  },

  "ffmpeg/ffmpeg": {
    product: "FFmpeg", lang: "C", syntax: "c", issueBase: 11200,
    build: "a default ./configure build",
    released: ["4.4.4", "5.1.4", "6.1.1", "7.0.2", "7.1"],
    unreleased: ["8.3", "9.0"],
    subsystems: [
      { file: "libavcodec/h264_slice.c", lines: 2900, kind: "native",
        fns: ["ff_h264_decode_mb_cabac_ex", "h264_slice_header_grow"],
        callers: ["avcodec_send_packet", "avcodec_receive_frame", "av_read_frame"],
        artifacts: ["SPS with a large num_ref_frames", "slice header", "truncated NAL unit"],
        pocs: ["ffmpeg -i crafted.h264 -f null -"] },

      { file: "libavcodec/hevcdec.c", lines: 3800, kind: "native",
        fns: ["ff_hevc_sao_filter_row", "hevc_pps_parse_fast"],
        callers: ["avcodec_send_packet", "avcodec_receive_frame"],
        artifacts: ["SEI message", "PPS declaring 64 tile columns", "short-term RPS"],
        pocs: ["ffmpeg -i crafted.hevc -f null -"] },

      { file: "libavformat/mov.c", lines: 9000, kind: "native",
        fns: ["mov_read_trak_sidx", "mov_build_index_grow"],
        callers: ["avformat_open_input", "av_read_frame", "avformat_find_stream_info"],
        artifacts: ["moov atom", "stsc table", "sidx box"],
        pocs: ["ffprobe crafted.mp4"] },

      { file: "libavformat/matroskadec.c", lines: 4600, kind: "native",
        fns: ["matroska_parse_block_fast", "ebml_read_length_grow"],
        callers: ["avformat_open_input", "av_read_frame"],
        artifacts: ["Matroska cluster", "EBML length field", "SimpleBlock lacing"],
        pocs: ["ffprobe crafted.mkv"] },

      { file: "libavcodec/vp9.c", lines: 1800, kind: "native",
        fns: ["ff_vp9_decode_tiles_grow", "vp9_superframe_split_fast"],
        callers: ["avcodec_send_packet", "av_read_frame"],
        artifacts: ["VP9 superframe index", "tile column count", "segmentation map"],
        pocs: ["ffmpeg -i crafted.webm -f null -"] },

      { file: "libavutil/mem.c", lines: 600, kind: "native",
        fns: ["av_buffer_realloc_unsafe", "av_fast_malloc_grow"],
        callers: ["av_fast_realloc", "avcodec_send_packet", "sws_scale"],
        artifacts: ["frame larger than INT_MAX", "realloc of a shared buffer", "plane stride"],
        pocs: ["ffmpeg -i crafted.mp4 -vf scale=32000:32000 -f null -"] },
    ],
  },
};

/* A repo we hold no tree for. The header says so rather than implying the paths
   are its own: this project does not render invented data as if it were real,
   and that rule does not stop at the demo props. */
const GENERIC = {
  c: {
    product: "the library", lang: "C (assumed — no tree for this repo)", syntax: "c",
    issueBase: 1200, build: "a default build",
    released: ["1.2.3", "1.4.0", "2.0.1", "2.3.4"], unreleased: ["9.9.0"],
    subsystems: [
      { file: "src/parse.c", lines: 1400, kind: "native",
        fns: ["parse_header_grow", "parse_field_copy"],
        callers: ["parse_input", "handle_connection", "main"],
        artifacts: ["request header", "length prefix", "field value"],
        pocs: ["./fuzz_target crafted.bin"] },
      { file: "src/net.c", lines: 1600, kind: "native",
        fns: ["net_read_frame_fast", "net_buf_append_unsafe"],
        callers: ["read_message", "handle_connection", "main"],
        artifacts: ["frame", "chunked body", "length field"],
        pocs: ["nc target 8080 < payload.bin"] },
    ],
  },
  js: {
    product: "the package", lang: "JavaScript (assumed — no tree for this repo)", syntax: "js",
    issueBase: 2400, build: "the published build",
    released: ["1.8.2", "2.0.0", "2.4.1", "3.1.0"], unreleased: ["9.0.0"],
    subsystems: [
      { file: "lib/parser.js", lines: 900, kind: "script",
        fns: ["parseHeaderUnsafe", "mergeOptionsDeep"],
        callers: ["createClient", "handleRequest", "JSON.parse"],
        artifacts: ["options object", "JSON body", "query string"],
        pocs: ["curl -X POST -d @payload.json http://localhost:3000/"] },
      { file: "src/index.js", lines: 600, kind: "script",
        fns: ["resolvePathFast", "deserializePayload"],
        callers: ["require", "createClient", "handleRequest"],
        artifacts: ["config file", "archive member", "serialized payload"],
        pocs: ["node repro.js"] },
    ],
  },
  py: {
    product: "the package", lang: "Python (assumed — no tree for this repo)", syntax: "py",
    issueBase: 3100, build: "the published wheel",
    released: ["0.9.4", "1.0.2", "1.3.0", "2.1.1"], unreleased: ["9.0.0"],
    subsystems: [
      { file: "src/parser.py", lines: 800, kind: "script",
        fns: ["_parse_header_unsafe", "_load_config_fast"],
        callers: ["load", "parse_file", "Client.request"],
        artifacts: ["YAML document", "header", "pickle payload"],
        pocs: ["python3 repro.py"] },
      { file: "src/utils/paths.py", lines: 400, kind: "script",
        fns: ["_sanitize_path", "_join_member"],
        callers: ["extract", "load", "Client.request"],
        artifacts: ["archive member", "path segment", "symlink entry"],
        pocs: ["python3 -m pkg extract evil.tar"] },
    ],
  },
};

function profileFor(repo) {
  const exact = PROFILES[repo.toLowerCase()];
  if (exact) return { ...exact, assumed: false };
  const name = repo.toLowerCase();
  if (/(^|[^a-z])(js|node|ts|npm|react|vue)([^a-z]|$)/.test(name)) return { ...GENERIC.js, assumed: true };
  if (/(^|[^a-z])(py|python|django|flask)([^a-z]|$)/.test(name)) return { ...GENERIC.py, assumed: true };
  return { ...GENERIC.c, assumed: true };
}

/* ============================================================================
   REPORT TEMPLATES
   ----------------------------------------------------------------------------
   One entry per vulnerability class. Each carries:

     titles  three CVE-style phrasings, so the queue does not read as one
             sentence with the nouns swapped
     mech    the mechanism described COHERENTLY
     contra  the same mechanism described INCOHERENTLY — the self-contradiction
             tell. Each variant states its own tell, so --dry can show the
             operator exactly what was planted
     code    lines that look lifted from the file, per language syntax, indexed
             to match the mech/contra variant — a snippet that does not match
             the prose above it is the one mismatch a reviewer always catches
     impact  the confident consequence paragraph
     fix     the confident remediation paragraph

   sev lists are deliberately top-heavy. Real AI-generated reports claim
   critical far more often than the distribution of real bugs would justify, and
   the demo should carry that bias rather than a tidy spread.
   ========================================================================= */
const CLASSES = [
  {
    id: "heap-overflow", kind: "native", cwe: "CWE-122 (heap-based buffer overflow)",
    sev: ["critical", "critical", "high"],
    titles: [
      (c) => `Heap-based buffer overflow in ${c.fn}() when a ${c.artifact} exceeds ${c.size} bytes`,
      (c) => `Remotely triggerable buffer overflow in ${c.fn}() via an oversized ${c.artifact}`,
      (c) => `Unchecked memcpy in ${c.fn}() reachable from ${c.caller}`,
    ],
    mech: [
      (c) => `${c.fn}() copies the ${c.artifact} into a fixed ${c.size}-byte heap allocation without comparing the length first, so a ${c.size + 88}-byte value runs past the end of the chunk and overwrites the header of the next allocation.`,
      (c) => `The length of the ${c.artifact} is attacker-controlled and is never checked against the ${c.size}-byte destination inside ${c.fn}(), so the copy continues straight into adjacent heap memory.`,
    ],
    contra: [
      { t: (c) => `${c.fn}() copies the ${c.artifact} into a fixed ${c.size}-byte buffer on the stack, and the overflow corrupts the adjacent heap chunk header, which is what makes this exploitable rather than a simple crash.`,
        why: "a stack buffer cannot corrupt heap chunk metadata" },
      { t: (c) => `The destination in ${c.fn}() is a ${c.size}-byte stack array returned by malloc(), so the overflow is a stack smash and a heap corruption at the same time.`,
        why: "malloc() does not return stack memory" },
    ],
    code: { c: [(c) => `memcpy(dst, ${c.v}, len);   /* len attacker-controlled, dst is ${c.size} bytes */`],
            js: [(c) => `target.set(${c.v}, 0);   // ${c.v}.byteLength never checked against target`],
            py: [(c) => `memcpy(dst, ${c.v}, len);   /* len attacker-controlled */`] },
    impact: [
      (c) => `An attacker who controls the ${c.artifact} gets remote code execution in the ${c.product} process. No authentication and no user interaction are required.`,
      (c) => `Reliable remote code execution against any ${c.product} process that talks to an attacker-controlled peer.`,
    ],
    fix: [
      (c) => `Bound the copy with sizeof(dst) and reject any ${c.artifact} longer than ${c.size} bytes before the copy happens.`,
      (c) => `Replace the copy in ${c.fn}() with a length-checked helper and add a regression test for the ${c.size + 88}-byte case.`,
    ],
  },

  {
    id: "use-after-free", kind: "native", cwe: "CWE-416 (use after free)",
    sev: ["critical", "high", "high"],
    titles: [
      (c) => `Use-after-free in ${c.fn}() when ${c.caller} returns early`,
      (c) => `Use-after-free in ${c.fn}() while processing a ${c.artifact}`,
      (c) => `Dangling pointer in ${c.fn}() after a ${c.artifact} is rejected`,
    ],
    mech: [
      (c) => `${c.fn}() releases the ${c.artifact} buffer on the error path and then reads its length field two statements later. The pointer is never cleared, so the read lands in freed memory.`,
      (c) => `When ${c.caller} fails, ${c.fn}() frees the context but leaves it linked into the connection, and the next ${c.artifact} dereferences it.`,
    ],
    contra: [
      { t: (c) => `${c.fn}() frees the ${c.artifact} buffer and then dereferences it. That is harmless on its own because the object lives on the stack, but the freed heap chunk has already been reused by the next allocation, so the write is fully controlled.`,
        why: "an object cannot be both stack-resident and a freed heap chunk" },
      { t: (c) => `In ${c.fn}() the buffer is freed exactly once and read afterwards, which is why this is also a double free.`,
        why: "freed exactly once is not a double free" },
    ],
    code: { c: [(c) => `free(ctx->${c.v});  /* two statements later */  len = ctx->${c.v}->len;`,
                (c) => `free(ctx->${c.v});   /* still linked into ctx->conn */`],
            js: [(c) => `${c.v}.destroy();  /* two statements later */  size = ${c.v}.handle.length;`],
            py: [(c) => `free(ctx->${c.v});  /* two statements later */  len = ctx->${c.v}->len;`,
                 (c) => `PyMem_Free(ctx->${c.v});   /* still referenced by the parser state */`] },
    impact: [
      (c) => `Controlling the contents of the reused chunk turns this into remote code execution. At minimum it is a remotely triggerable crash of every ${c.product} process on the host.`,
      () => `A remote attacker can groom the heap and take control of the instruction pointer.`,
    ],
    fix: [
      (c) => `Set the pointer to NULL immediately after the free in ${c.fn}(), and unlink the context before releasing it.`,
      () => `Move the free to the single exit path so the error path cannot leave a dangling reference.`,
    ],
  },

  {
    id: "integer-overflow", kind: "native", cwe: "CWE-190 (integer overflow)",
    sev: ["critical", "high", "high"],
    titles: [
      (c) => `Integer overflow in ${c.fn}() produces an undersized allocation in ${c.file}`,
      (c) => `Length computation wraps in ${c.fn}() when a ${c.artifact} declares ${c.size} elements`,
      (c) => `Allocation size overflow in ${c.fn}() for a ${c.artifact} larger than 2 GB`,
    ],
    mech: [
      (c) => `${c.fn}() multiplies the declared element count by the element size in an int before handing the product to malloc(). A ${c.artifact} declaring 0x40000001 elements wraps the product to 4, and the loop that follows writes far past the allocation.`,
      (c) => `The size addition in ${c.fn}() is performed on a 32-bit value even on 64-bit builds, so a ${c.artifact} just under 4 GB yields a ${c.size}-byte buffer and an unbounded write.`,
    ],
    contra: [
      { t: (c) => `The size computation in ${c.fn}() wraps because the count is unsigned, which makes the result negative, and malloc() then succeeds with that negative size.`,
        why: "an unsigned product is never negative, and malloc() of a negative size does not succeed" },
      { t: (c) => `${c.fn}() guards the multiplication with __builtin_mul_overflow() and returns an error, so the undersized buffer is allocated and the write proceeds.`,
        why: "a guard that returns an error cannot then let the write proceed" },
    ],
    code: { c: [(c) => `${c.v} = malloc(hdr->count * sizeof(*${c.v}));   /* int product, wraps */`,
                (c) => `${c.v} = malloc((int)(hdr->len + pad));   /* 32-bit sum on 64-bit builds */`],
            js: [(c) => `const ${c.v} = Buffer.allocUnsafe(hdr.count * 4);   // wraps past 2^31`],
            py: [(c) => `${c.v} = PyMem_Malloc(n * sizeof(*${c.v}));   /* int product, wraps */`,
                 (c) => `${c.v} = PyMem_Malloc((int)(n + pad));   /* 32-bit sum */`] },
    impact: [
      (c) => `Heap corruption with attacker-chosen length and content, which means remote code execution in ${c.product}.`,
      () => `Any input large enough to wrap the computation gives a controlled heap write.`,
    ],
    fix: [
      () => `Compute the size in size_t with a checked multiplication, and reject the input when it overflows.`,
      (c) => `Clamp the declared count in ${c.fn}() to a documented maximum before any arithmetic.`,
    ],
  },

  {
    id: "oob-read", kind: "native", cwe: "CWE-125 (out-of-bounds read)",
    sev: ["high", "high", "medium"],
    titles: [
      (c) => `Out-of-bounds read in ${c.fn}() when a ${c.artifact} is truncated`,
      (c) => `Heap over-read of up to ${c.size} bytes in ${c.fn}()`,
      (c) => `Information disclosure in ${c.fn}() via a short ${c.artifact}`,
    ],
    mech: [
      (c) => `${c.fn}() iterates to the length declared in the ${c.artifact} rather than the number of bytes actually received, so a truncated ${c.artifact} walks up to ${c.size} bytes past the end of the buffer.`,
      (c) => `The bounds check in ${c.fn}() uses the declared size, which the peer controls, so the loop reads the heap memory that follows the allocation and copies it into the response.`,
    ],
    contra: [
      { t: (c) => `The loop reads up to ${c.size} bytes past the end of the buffer, although the buffer is ${c.size} bytes long, so the read stays inside the allocation and still discloses adjacent heap memory.`,
        why: "a read cannot be both inside the allocation and past its end" },
      { t: (c) => `${c.fn}() is called with a NULL buffer on this path, and the over-read therefore returns the ${c.size} bytes that followed the previous allocation.`,
        why: "a NULL buffer has nothing after it to over-read" },
    ],
    code: { c: [(c) => `for (i = 0; i < hdr->declared_len; i++)  dst[i] = ${c.v}[i];   /* declared */`],
            js: [(c) => `for (let i = 0; i < hdr.declaredLen; i++) out[i] = ${c.v}[i];   // declared`],
            py: [(c) => `for (i = 0; i < hdr->declared_len; i++)  dst[i] = ${c.v}[i];   /* declared */`] },
    impact: [
      (c) => `Up to ${c.size} bytes of adjacent heap memory are returned to the peer on every request, which is enough to recover session material over repeated requests.`,
      () => `Remote memory disclosure, repeatable at will and invisible in the logs.`,
    ],
    fix: [
      () => `Use the received length as the loop bound and reject a declared length that exceeds it.`,
      (c) => `Validate the ${c.artifact} length against the allocation before the loop in ${c.fn}().`,
    ],
  },

  {
    id: "double-free", kind: "native", cwe: "CWE-415 (double free)",
    sev: ["high", "high", "medium"],
    titles: [
      (c) => `Double free in ${c.fn}() on the ${c.artifact} error path`,
      (c) => `Double free in ${c.fn}() when ${c.caller} fails twice on one connection`,
      (c) => `Allocator corruption through a double free in ${c.fn}()`,
    ],
    mech: [
      (c) => `${c.fn}() frees the ${c.artifact} buffer and then returns a failure, and ${c.caller} frees the same pointer again during cleanup. Two ${c.artifact}s on one connection are enough to reach it.`,
      (c) => `The cleanup path in ${c.fn}() runs for both the partial and the final parse, so the same allocation is released twice.`,
    ],
    contra: [
      { t: (c) => `In ${c.fn}() the second free() is reached only once, which is precisely why this is a double free.`,
        why: "reached once means freed once" },
      { t: (c) => `The allocation is on the stack, so the first free() is a no-op and only the second corrupts the allocator metadata.`,
        why: "stack memory is never passed to free(), and freeing it is not a no-op" },
    ],
    code: { c: [(c) => `if (!parse(${c.v})) { free(${c.v}); return -1; }   /* caller frees it again */`],
            js: [(c) => `if (!parse(${c.v})) { ${c.v}.close(); return null; }   // caller closes it again`],
            py: [(c) => `if (!parse(${c.v})) { PyMem_Free(${c.v}); return NULL; }   /* freed again */`] },
    impact: [
      (c) => `Allocator metadata corruption, a well-understood path to remote code execution in ${c.product}.`,
      () => `A remotely triggerable abort at minimum, and a controlled write at worst.`,
    ],
    fix: [
      () => `Make ownership explicit: free in the caller only, and NULL the pointer after the free.`,
      (c) => `Remove the free from ${c.fn}() and document that the caller owns the buffer.`,
    ],
  },

  {
    id: "race", kind: "native", cwe: "CWE-362 (race condition)",
    sev: ["high", "medium", "medium"],
    titles: [
      (c) => `Race condition in ${c.fn}() between the length check and the copy`,
      (c) => `TOCTOU in ${c.fn}() when two ${c.artifact}s arrive on one connection`,
      (c) => `Unsynchronised access to the shared ${c.artifact} state in ${c.fn}()`,
    ],
    mech: [
      (c) => `${c.fn}() validates the ${c.artifact} length, releases the lock, and only then performs the copy. A second thread can replace the buffer inside that window, so the copy uses a length that no longer matches the data.`,
      (c) => `The ${c.artifact} cache is read in ${c.fn}() without holding the connection lock, so a concurrent eviction frees the entry while it is in use.`,
    ],
    contra: [
      { t: (c) => `The window is a single instruction wide, so it is reliably winnable from another thread even though ${c.product} holds the lock across the whole of ${c.fn}().`,
        why: "a lock held across the whole function leaves no window" },
      { t: (c) => `The race reproduces in a single-threaded build, which confirms the window between the two threads in ${c.fn}().`,
        why: "a single-threaded build has no second thread" },
    ],
    code: { c: [(c) => `if (len <= sizeof(buf)) { unlock(&ctx->mtx); memcpy(buf, ${c.v}, len); }`,
                (c) => `entry = cache_get(ctx, key);   /* ctx->mtx not held here */  use(entry->${c.v});`],
            js: [(c) => `if (len <= buf.length) { await yieldToLoop(); ${c.v}.copy(buf, 0, 0, len); }`,
                 (c) => `const entry = cache.get(key);   // no lock held  use(entry.${c.v});`],
            py: [(c) => `if len <= len(buf): lock.release(); buf[:len] = ${c.v}[:len]`,
                 (c) => `entry = cache.get(key)   # lock not held  use(entry.${c.v})`] },
    impact: [
      (c) => `A multi-threaded ${c.product} application can be driven into heap corruption by a remote peer, with no authentication.`,
      () => `Memory corruption under concurrent load, which in practice means a crash loop in production.`,
    ],
    fix: [
      () => `Hold the lock across the check and the copy, or re-validate the length after reacquiring it.`,
      (c) => `Take a reference on the cache entry in ${c.fn}() before releasing the lock.`,
    ],
  },

  {
    id: "timing", kind: "native", needs: "crypto", cwe: "CWE-208 (observable timing discrepancy)",
    sev: ["high", "medium", "medium"],
    titles: [
      (c) => `Timing side channel in ${c.fn}() when the constant-time flag is dropped`,
      (c) => `Key recovery in ${c.fn}() through a measurable difference on the error path`,
      (c) => `Non-constant-time comparison of the ${c.artifact} in ${c.fn}()`,
    ],
    mech: [
      (c) => `${c.fn}() restores the constant-time flag on the success path only. On the error path it stays cleared, leaving a difference of roughly ${c.size} cycles that is measurable across a LAN.`,
      (c) => `The ${c.artifact} is compared with memcmp() inside ${c.fn}(), which returns at the first differing byte, so the comparison leaks a byte at a time.`,
    ],
    contra: [
      { t: (c) => `The comparison in ${c.fn}() is constant time, which is exactly why the timing difference is measurable over the network.`,
        why: "constant time is the absence of a measurable difference" },
      { t: (c) => `The measurement in ${c.fn}() requires local access, so a remote attacker recovers the key in about 4,000 requests.`,
        why: "local-only measurement does not give a remote attack" },
    ],
    code: { c: [() => `BN_set_flags(b, 0);   /* BN_FLG_CONSTTIME restored on success only */`,
                (c) => `if (memcmp(${c.v}, expected, len) != 0) goto err;   /* early return leaks */`],
            js: [() => `ctx.setAutoPadding(false);   // constant-time path only on success`,
                 (c) => `if (${c.v}.toString("hex") !== expected) throw err;   // early return leaks`],
            py: [() => `ctx.set_flags(0)   # constant-time flag restored on success only`,
                 (c) => `if ${c.v} != expected: raise SSLError   # early return leaks`] },
    impact: [
      (c) => `Private key recovery against any ${c.product} server reachable on the network, given enough samples.`,
      () => `A remote attacker distinguishes valid from invalid material and recovers it byte by byte.`,
    ],
    fix: [
      () => `Use a constant-time comparison, and restore the flag in a single exit path.`,
      (c) => `Move the flag restoration in ${c.fn}() above the error label so both paths run it.`,
    ],
  },

  {
    id: "proto-pollution", kind: "script", syntax: "js", cwe: "CWE-1321 (prototype pollution)",
    sev: ["critical", "high", "high"],
    titles: [
      (c) => `Prototype pollution in ${c.fn}() via a crafted ${c.artifact}`,
      (c) => `Remote code execution through prototype pollution in ${c.fn}()`,
      (c) => `Unfiltered __proto__ key reaches ${c.fn}() from ${c.caller}`,
    ],
    mech: [
      (c) => `${c.fn}() merges the ${c.artifact} into its options object with Object.assign() and never rejects the __proto__ key, so any property on Object.prototype can be set from a request.`,
      (c) => `The recursive merge in ${c.fn}() walks attacker-supplied keys without checking for __proto__ or constructor, so one ${c.artifact} changes behaviour process-wide.`,
    ],
    contra: [
      { t: (c) => `${c.fn}() builds the target with Object.create(null), which is why the __proto__ key reaches Object.prototype and pollutes every object in the process.`,
        why: "a null-prototype target is the standard defence, not the cause" },
      { t: (c) => `The merge in ${c.fn}() is shallow, so nested keys such as a.b.__proto__.polluted are applied recursively.`,
        why: "a shallow merge does not apply nested keys" },
    ],
    code: { js: [(c) => `for (const k of Object.keys(${c.v})) target[k] = ${c.v}[k];   // __proto__ kept`] },
    impact: [
      (c) => `Setting Object.prototype.shell gives remote code execution in any ${c.product} process that later spawns a child. Unauthenticated and remote.`,
      () => `A process-wide behaviour change from one request, escalating to RCE through any downstream sink.`,
    ],
    fix: [
      () => `Reject __proto__, constructor and prototype keys, and use a Map for untrusted input.`,
      (c) => `Replace the hand-rolled merge in ${c.fn}() with structuredClone plus an allowlist of keys.`,
    ],
  },

  {
    id: "path-traversal", kind: "script", cwe: "CWE-22 (path traversal)",
    sev: ["critical", "high", "high"],
    titles: [
      (c) => `Path traversal in ${c.fn}() when handling a ${c.artifact}`,
      (c) => `Arbitrary file write in ${c.fn}() via ../ segments in a ${c.artifact}`,
      (c) => `${c.caller} escapes the destination directory through ${c.fn}()`,
    ],
    mech: [
      (c) => `${c.fn}() normalises the ${c.artifact} after joining it to the destination directory rather than before, so a name such as ../../etc/cron.d/x escapes the extraction root.`,
      (c) => `The traversal check in ${c.fn}() runs on the raw ${c.artifact} but the write uses the decoded form, so %2e%2e%2f survives the check.`,
    ],
    contra: [
      { t: (c) => `${c.fn}() resolves the ${c.artifact} to an absolute path first, which is what allows the ../ segments to survive the join.`,
        why: "resolving collapses ../ segments rather than preserving them" },
      { t: (c) => `The destination is validated with a startsWith() check against the root, so the escape succeeds.`,
        why: "a startsWith() check against the root is what blocks the escape" },
    ],
    code: { js: [(c) => `const dest = normalize(join(root, ${c.v}.name));   // normalised after the join`,
                 (c) => `if (!${c.v}.name.includes("..")) write(join(root, decode(${c.v}.name)));`],
            py: [(c) => `dest = os.path.normpath(os.path.join(root, ${c.v}.name))   # after the join`,
                 (c) => `if ".." not in ${c.v}.name: open(os.path.join(root, unquote(${c.v}.name)), "wb")`] },
    impact: [
      (c) => `Any ${c.product} caller that handles an untrusted ${c.artifact} can be made to write to an arbitrary path, which means code execution on the next scheduled run.`,
      () => `Arbitrary file write as the running user, trivially escalated to code execution.`,
    ],
    fix: [
      () => `Resolve the joined path and reject anything outside the destination root before opening the file.`,
      (c) => `Reject names containing .. or an absolute prefix in ${c.fn}() before any filesystem call.`,
    ],
  },

  {
    id: "deserialization", kind: "script", cwe: "CWE-502 (deserialization of untrusted data)",
    sev: ["critical", "critical", "high"],
    titles: [
      (c) => `Remote code execution in ${c.fn}() through an untrusted ${c.artifact}`,
      (c) => `Unsafe deserialization in ${c.fn}() reachable from ${c.caller}`,
      (c) => `${c.fn}() instantiates attacker-named classes from a ${c.artifact}`,
    ],
    mech: [
      (c) => `${c.fn}() hands the ${c.artifact} straight to the deserializer with no allowlist, so the payload chooses which class is constructed and which method runs during construction.`,
      (c) => `The type tag in the ${c.artifact} is used as a lookup key inside ${c.fn}() without validation, so any importable callable can be reached.`,
    ],
    contra: [
      { t: (c) => `${c.fn}() runs the deserializer in a sandbox with no module loader, which is how the payload imports the subprocess module.`,
        why: "a sandbox with no module loader cannot import a module" },
      { t: (c) => `The ${c.artifact} is validated against the schema before it is parsed, so the malicious type survives validation.`,
        why: "validation before parsing is what rejects the malicious type" },
    ],
    code: { js: [(c) => `const obj = deserialize(${c.v});   // no type allowlist`,
                 (c) => `const ctor = registry[${c.v}.type];   // type tag used as a lookup key`],
            py: [(c) => `obj = loads(${c.v})   # no type allowlist`,
                 (c) => `cls = _registry[${c.v}["type"]]   # type tag used as a lookup key`] },
    impact: [
      (c) => `Unauthenticated remote code execution in every ${c.product} deployment that accepts this input. This is the highest-severity class of bug and should be treated as such.`,
      () => `Full compromise of the host from a single unauthenticated request.`,
    ],
    fix: [
      () => `Deserialize into a fixed schema with an explicit allowlist of types, and never construct classes named by the input.`,
      (c) => `Replace ${c.fn}() with a parser that returns plain data, and validate it afterwards.`,
    ],
  },

  {
    id: "redos", kind: "script", cwe: "CWE-1333 (inefficient regular expression complexity)",
    sev: ["high", "medium", "medium"],
    titles: [
      (c) => `Regular expression denial of service in ${c.fn}() via a crafted ${c.artifact}`,
      (c) => `Catastrophic backtracking in ${c.fn}() when a ${c.artifact} is ${c.size} bytes long`,
      (c) => `Single-request CPU exhaustion through ${c.fn}()`,
    ],
    mech: [
      (c) => `The pattern used in ${c.fn}() contains nested quantifiers, so a ${c.artifact} of ${c.size} bytes made of repeated whitespace drives the matcher into exponential backtracking and pins one core for minutes.`,
      (c) => `${c.fn}() validates the ${c.artifact} with an unanchored pattern whose two alternatives overlap, so a non-matching input of ${c.size} bytes takes quadratic time.`,
    ],
    contra: [
      { t: (c) => `The pattern in ${c.fn}() is linear-time, which is why a ${c.size}-byte ${c.artifact} takes exponential time to reject.`,
        why: "a linear-time pattern cannot take exponential time" },
      { t: (c) => `${c.fn}() rejects the ${c.artifact} before the match runs, so the backtracking still occurs on every request.`,
        why: "rejecting before the match means the match never runs" },
    ],
    code: { js: [() => `const re = /^(\\s*\\w+)+$/;   // nested quantifier`,
                 () => `const re = /(\\w+|\\s+\\w+)*$/;   // overlapping alternatives, unanchored`],
            py: [() => `re.match(r"^(\\s*\\w+)+$", value)   # nested quantifier`,
                 () => `re.search(r"(\\w+|\\s+\\w+)*$", value)   # overlapping alternatives`] },
    impact: [
      (c) => `One unauthenticated request takes a ${c.product} worker off the pool for minutes. A handful per second is a complete outage.`,
      () => `Trivial unauthenticated denial of service, with no rate limit able to help once the request is accepted.`,
    ],
    fix: [
      () => `Rewrite the pattern without nested quantifiers, or bound the input length before matching.`,
      (c) => `Replace the regular expression in ${c.fn}() with an explicit parser and cap the ${c.artifact} length.`,
    ],
  },
];

/* The closing line is the clearest tell in the real reports: boundless
   availability, a question about the bounty, and no actual proof of concept. */
const CLOSERS = [
  "Please let me know if you would like me to prepare a patch. I am available for a call at your convenience.",
  "I am happy to provide further clarification. Could you confirm the bounty range for a critical finding?",
  "This is a high-impact issue and I would appreciate an expedited review.",
  "I have withheld the full exploit for safety reasons; let me know where to send it.",
  "I have not requested a CVE yet and will wait for your acknowledgement before doing so.",
  "I reviewed the surrounding code as well and this is the only instance of the pattern I found.",
];

const CONFIDENCE = [
  "I have reproduced this on current master.",
  "I verified this against the latest release and on master.",
  "This was found during a systematic review of the parsing code and confirmed by hand.",
  "The behaviour is deterministic and reproduces on every run.",
];

/* Real vectors, and the scores are the ones CVSS 3.1 actually produces for
   them. A judge who checks the arithmetic finds that it holds — which is the
   problem in miniature: the fabrication is never in the parts easy to check. */
const CVSS = {
  critical: [["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "9.8"],
             ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H", "9.6"]],
  high: [["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H", "8.1"],
         ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", "7.5"]],
  medium: [["CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N", "6.5"],
           ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N", "5.3"]],
  low: [["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N", "3.7"],
        ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N", "3.3"]],
};

const SIZES = [128, 256, 512, 1024, 2048, 4096];
const VARS = ["line", "hdr", "val", "payload", "chunk", "member"];

/* "Curl_http" -> "Curl_http()", but "import()" and "server.on('request')" are
   left alone rather than becoming "import()()". */
const callRef = (name) => (/\)$/.test(name) ? name : name + "()");

/* ============================================================================
   GENERATION
   ========================================================================= */
function generateOne(profile, repo, issue, avoidFile) {
  const sub = pick(profile.subsystems);
  /* Two consecutive reports against the same file read as one template being
     re-rolled, which is the thing the queue makes most visible. */
  if (avoidFile && sub.file === avoidFile && profile.subsystems.length > 1) return null;

  const topics = sub.topics ?? [];
  const usable = CLASSES.filter(
    (k) => k.kind === sub.kind &&
           (!k.needs || topics.includes(k.needs)) &&
           (!k.syntax || k.syntax === profile.syntax) &&
           (k.code[profile.syntax] ?? []).length > 0,
  );
  if (!usable.length) return null;
  const klass = pick(usable);

  /* Which tells this report carries. The invented function is always one of
     them — it is the definition of fabricated in src/triage/zerog.mjs. The
     other two vary, because twenty reports with identical tells would read as
     one template on camera, and a judge would be right to say so. */
  const tellLine = chance(0.7);
  const tellContra = chance(0.55);
  const tellVersion = chance(0.35);
  /* at least two tells per report, so none is merely "a report that is wrong" */
  const forced = !tellLine && !tellContra && !tellVersion;

  const severity = pick(klass.sev);
  const [vector, score] = pick(CVSS[severity]);
  const vA = pick(profile.released.slice(0, Math.max(1, profile.released.length - 2)));
  const vB = tellVersion || forced
    ? pick(profile.unreleased)
    : profile.released[profile.released.length - 1];

  const c = {
    fn: pick(sub.fns),
    /* Callers are written as the project writes them, so some already carry
       their own parentheses (import(), server.on('request')). Templates use
       c.caller verbatim rather than appending "()" to it. */
    caller: callRef(pick(sub.callers)),
    artifact: pick(sub.artifacts),
    file: sub.file,
    size: pick(SIZES),
    v: pick(VARS),
    product: profile.product,
  };
  /* The impossible line: a multiple of the file's length, so it is past the end
     of the file in any version anyone could be reading. */
  c.line = tellLine || forced
    ? Math.round(sub.lines * (2.4 + rnd() * 3.2))
    : Math.max(12, Math.round(sub.lines * (0.1 + rnd() * 0.8)));

  /* One variant index drives the prose AND the snippet, so the code shown is
     always the code the paragraph above it describes. */
  const variant = int(0, Math.max(klass.mech.length, klass.contra.length) - 1);
  const contra = klass.contra[Math.min(variant, klass.contra.length - 1)];
  const mechanism = tellContra || forced
    ? contra.t(c)
    : klass.mech[Math.min(variant, klass.mech.length - 1)](c);
  const snippets = klass.code[profile.syntax];
  const snippet = snippets[Math.min(variant, snippets.length - 1)](c);

  const body = [
    `Summary: ${mechanism} ${pick(CONFIDENCE)}`,
    `Affected: ${profile.product} ${vA} through ${vB}, ${profile.build}.`,
    `Technical detail: the defect is at ${c.file}:${c.line}, inside ${c.fn}(), which is reached ` +
      `from ${c.caller} for every ${c.artifact}, so no unusual configuration is required:`,
    snippet,
    `Reproduction: ${pick(sub.pocs)}`,
    `Impact: ${klass.cwe}. ${vector} (${score} ${severity}). ${pick(klass.impact)(c)}`,
    `Suggested fix: ${pick(klass.fix)(c)}`,
    pick(CLOSERS),
  ].join("\n\n");

  const tells = [`${c.fn}() does not exist in ${repo}`];
  if (tellLine || forced) tells.push(`${c.file} is about ${sub.lines} lines; cites line ${c.line}`);
  if (tellContra || forced) tells.push(`self-contradiction: ${contra.why}`);
  if (tellVersion || forced) tells.push(`claims ${profile.product} ${vB}, which is not a released version`);

  return {
    caseId: "wb-slop-" + hex(8),
    repo,
    issue,
    severity,
    /* Act 1 is the world WITHOUT a bond, so the flood arrives in the free lane
       by default. --lane priority or --lane mix is there for later footage. */
    lane: LANE === "mix" ? (chance(0.35) ? "priority" : "free") : LANE,
    title: pick(klass.titles)(c),
    body,
    openedAt: Date.now(),
    daysLeft: 90 - int(0, 3),

    /* the markings, plus the generator's own notes on what it planted. See
       rule 3 in the header: a reader downstream should never have to guess. */
    synthetic: true,
    generator: "slopbot",
    seed: SEED,
    file: c.file,
    tells,
  };
}

function generate(profile, repo, count) {
  const out = [];
  const seen = new Set();
  /* Issue numbers climb, so the flood reads as consecutive filings on one
     tracker rather than twenty unrelated numbers. */
  let issue = profile.issueBase + int(1, 9);
  let attempts = 0;

  while (out.length < count && attempts < count * 80) {
    attempts++;
    const prevFile = out.length ? out[out.length - 1].file : null;
    const r = generateOne(profile, repo, issue, prevFile);
    /* Dedup on the title: the queue shows titles, and two identical rows are
       the one thing a viewer notices immediately. */
    if (!r || seen.has(r.title)) continue;
    seen.add(r.title);
    out.push(r);
    issue += int(1, 5);
  }
  return out;
}

/* ============================================================================
   OUTPUT
   ========================================================================= */
const wrap = (text, width, pad) =>
  text.split("\n").flatMap((para) => {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines = [];
    let line = "";
    for (const w of words) {
      if (line && (line + " " + w).length > width) { lines.push(line); line = w; }
      else line = line ? line + " " + w : w;
    }
    lines.push(line);
    return lines;
  }).map((l) => (l ? pad + l : ""));

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

const profile = profileFor(REPO);
const reports = generate(profile, REPO, COUNT);
if (!reports.length) {
  console.error("slopbot: no template applies to " + REPO + " — this is a bug in the profile table");
  process.exit(1);
}
const gap = reports.length > 1 ? (OVER * 1000) / (reports.length - 1) : 0;

console.log("");
console.log("WaspBounty · slopbot — fabricated reports, at volume");
console.log("");
console.log("  target   : " + REPO + "  (" + profile.lang + ")");
console.log("  endpoint : " + (DRY ? "none — --dry" : "POST " + BASE + ROUTE));
console.log("  volume   : " + reports.length + " reports over " + OVER + "s  " +
  (reports.length > 1 && OVER > 0 ? `(one every ${(gap / 1000).toFixed(1)}s)` : "(as fast as possible)"));
console.log("  marking  : caseId wb-slop-*, synthetic: true, header x-wasp-synthetic");
console.log("  seed     : " + SEED + "  (replay with --seed " + SEED + ")");
console.log("");

/* ---- dry run: print them, send nothing ---------------------------------- */
if (DRY) {
  reports.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2, "0")}/${reports.length}  ${r.caseId}  ` +
                `${r.repo}#${r.issue}  ${r.severity}  ${r.lane} lane`);
    console.log("");
    for (const l of wrap(r.title, 86, "      ")) console.log(l);
    console.log("");
    for (const l of wrap(r.body, 86, "      ")) console.log(l);
    console.log("");
    for (const l of wrap("tells: " + r.tells.join(" · "), 86, "      ")) console.log(l);
    console.log("");
  });

  const sev = {};
  for (const r of reports) sev[r.severity] = (sev[r.severity] || 0) + 1;
  console.log(`  ${reports.length} generated, nothing sent.  ` +
    Object.entries(sev).map(([k, v]) => `${k} ${v}`).join(" · "));
  console.log(`  distinct titles ${new Set(reports.map((r) => r.title)).size}/${reports.length}` +
    `   distinct functions ${new Set(reports.map((r) => r.tells[0])).size}` +
    `   distinct files ${new Set(reports.map((r) => r.file)).size}`);
  console.log("");
  console.log("  one-time note — add this to the \"scripts\" block of package.json yourself:");
  console.log("    \"slop\": \"node scripts/slopbot.mjs\",");
  console.log("");
  process.exit(0);
}

/* ---- live run ------------------------------------------------------------ */

/* One line, no stack trace. A refused connection is the failure mode that
   would otherwise print twenty identical traces into the demo terminal. */
const friendly = (e) => {
  const code = e?.cause?.code || e?.code || "";
  if (code === "ECONNREFUSED") return `nothing is listening on ${BASE} — start it with: npm run serve`;
  if (code === "ENOTFOUND") return `cannot resolve the host in ${BASE}`;
  if (code === "ECONNRESET") return `${BASE} closed the connection`;
  if (e?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return `${BASE} did not answer in time`;
  return String(e?.message || e).split("\n")[0].slice(0, 160);
};

/* Every request closes its socket. Two reasons: a bot flood opening a fresh
   connection per report is the realistic shape, and more practically, keeping
   sockets pooled leaves libuv handles open at exit — on Windows that turns a
   process.exit() into an assertion crash instead of an exit code. Nothing
   below calls process.exit(); the exit code is set and the loop drains. */
const HEADERS = { "content-type": "application/json", "x-wasp-synthetic": "1", connection: "close" };

let reachable = true;
try {
  const res = await fetch(BASE + "/api/health", {
    headers: { connection: "close" },
    signal: AbortSignal.timeout(6000),
  });
  await res.text().catch(() => {});
  if (!res.ok) {
    console.error(`  the app answered HTTP ${res.status} at ${BASE}/api/health — is --url right?`);
    reachable = false;
  }
} catch (e) {
  console.error("  " + friendly(e));
  reachable = false;
}
if (!reachable) process.exitCode = 1;

/* Pacing is scheduled against absolute wall-clock targets rather than one sleep
   per iteration, so a slow response cannot drag the window out. The jitter is
   deliberate: perfectly even spacing reads as a script on camera, and a real
   flood arrives ragged. */
const targets = reports
  .map((_, i) => Math.max(0, Math.round(i * gap + (i === 0 ? 0 : (rnd() - 0.5) * gap * 0.36))))
  .sort((a, b) => a - b);

const failures = [];
const inflight = [];

/* Fire and do not await. A triage round trip through the enclave can take tens
   of seconds, and blocking on it would wreck the pacing; Act 1 is about these
   reports arriving, not about the verdicts. Outcomes are collected at the end. */
const dispatch = (rep) =>
  fetch(BASE + ROUTE, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(rep),
    signal: AbortSignal.timeout(120000),
  })
    .then(async (res) => {
      await res.text().catch(() => {});
      if (res.ok) return { ok: true };
      return {
        ok: false,
        reason: res.status === 404
          ? `HTTP 404 — no POST route at ${ROUTE}; retarget with --path`
          : `HTTP ${res.status}`,
      };
    })
    .catch((e) => ({ ok: false, reason: friendly(e) }));

async function flood() {
  const t0 = Date.now();
  for (let i = 0; i < reports.length; i++) {
    const waitMs = t0 + targets[i] - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    const rep = { ...reports[i], openedAt: Date.now() };
    inflight.push(dispatch(rep).then((r) => {
      if (!r.ok) failures.push({ caseId: rep.caseId, reason: r.reason });
      return r;
    }));

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `  ${String(i + 1).padStart(2, "0")}/${reports.length}  ` +
      `t+${elapsed.padStart(5)}s  ${rep.severity.toUpperCase().padEnd(8)}  ` +
      `${rep.repo}#${rep.issue}  ${clip(rep.title, 62)}`,
    );
  }

  const results = await Promise.all(inflight);
  const accepted = results.filter((r) => r.ok).length;
  const took = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("");
  console.log(`  ${reports.length} filed in ${took}s   accepted ${accepted}   failed ${failures.length}`);
  if (failures.length) {
    /* one line per distinct reason, not one per report */
    for (const reason of new Set(failures.map((f) => f.reason))) {
      console.log("    " + failures.filter((f) => f.reason === reason).length + "x  " + reason);
    }
  }
  console.log("");
  console.log("  Every one carried synthetic: true and a wb-slop- caseId. Nothing above can be");
  console.log("  mistaken for a real report, and nothing above cost the sender anything.");
  console.log("");

  /* Total failure is a failure; partial delivery still produced the footage. */
  if (accepted === 0) process.exitCode = 1;
}

if (reachable) await flood();
