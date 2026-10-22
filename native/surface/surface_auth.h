#ifndef CW_AUTH_H
#define CW_AUTH_H

/* ===================================================================
 * auth.h -- surface authentication for the CW helper worker.
 *
 * The token is supplied ONLY by the parent process through the
 * environment (CW_SURFACE_TOKEN) and must be EXACTLY 64 hexadecimal
 * characters. There is no default token and no silent/fail-open
 * mode: if the environment variable is missing or malformed we clear
 * state and fail closed, which causes the worker to refuse to start.
 * =================================================================== */

#include <winsock2.h>
#include <windows.h>
#include <string.h>
#include <ctype.h>

/* Forward declarations of the original TU's static helpers used here.
 * We only *declare* them; the definitions stay in the original source so
 * this header can be dropped into the guarded TU without duplicating them.
 * A parameter-list mismatch against the original is a deliberate build signal.
 */
static int JsonStr(const char *line, const char *key, char *out, int cap);
static void SendLine(SOCKET s, const char *text);

#define CW_AUTH_TOKEN_LEN 64
#define CW_AUTH_HDR_MAX   128

/* Stored token: 64 hex chars + NUL. Zero length means "uninitialized". */
static char token[CW_AUTH_TOKEN_LEN + 1];

static int CwAuthIsHexN(const char *s, size_t n)
{
    size_t i;
    if (!s) return 0;
    for (i = 0; i < n; i++) {
        char c = s[i];
        int ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!ok) return 0;
    }
    return 1;
}

/* Constant-time compare of exactly CW_AUTH_TOKEN_LEN bytes.
 * Comparison is case sensitive: the token is opaque hex and must match
 * byte for byte. Always touches all bytes so timing does not leak. */
static int CwAuthTokenEquals(const char *a, const char *b)
{
    unsigned char diff = 0;
    size_t i;
    for (i = 0; i < CW_AUTH_TOKEN_LEN; i++)
        diff |= (unsigned char)(a[i] ^ b[i]);
    return diff == 0;
}

/* Read CW_SURFACE_TOKEN. Returns 1 on success, 0 on failure (token cleared). */
static int SurfaceAuthInit(void)
{
    char env[CW_AUTH_TOKEN_LEN + 2];
    DWORD n;

    memset(token, 0, sizeof(token));
    memset(env, 0, sizeof(env));

    n = GetEnvironmentVariableA("CW_SURFACE_TOKEN", env, (DWORD)sizeof(env));
    if (n != (DWORD)CW_AUTH_TOKEN_LEN) {       /* too long, too short, or missing */
        memset(env, 0, sizeof(env));
        memset(token, 0, sizeof(token));
        return 0;
    }
    if (!CwAuthIsHexN(env, CW_AUTH_TOKEN_LEN)) {
        memset(env, 0, sizeof(env));
        memset(token, 0, sizeof(token));
        return 0;
    }
    memcpy(token, env, CW_AUTH_TOKEN_LEN);
    token[CW_AUTH_TOKEN_LEN] = 0;
    memset(env, 0, sizeof(env));
    return 1;
}

/* Pull "token" from the request JSON and compare it to the stored token.
 * Returns 1 only when the request carries a valid 64-hex token that
 * matches exactly; any other case returns 0. */
static int SurfaceAuthAllowed(const char *line)
{
    char buf[CW_AUTH_HDR_MAX];
    int ok;

    if (token[0] == 0) return 0;               /* not initialized: fail closed */

    memset(buf, 0, sizeof(buf));
    /* Pull the token value into a bounded buffer. Returns NULL when absent. */
    if (!JsonStr(line, "token", buf, (int)sizeof(buf))) return 0;
    buf[CW_AUTH_HDR_MAX - 1] = 0;
    if (strlen(buf) != CW_AUTH_TOKEN_LEN) return 0;
    if (!CwAuthIsHexN(buf, CW_AUTH_TOKEN_LEN)) return 0;

    ok = CwAuthTokenEquals(buf, token);        /* constant time, case sensitive */
    memset(buf, 0, sizeof(buf));
    return ok;
}

/* Gate every request.
 *
 *   1) Auth must pass first. On failure answer AUTH_REQUIRED and shut the
 *      socket down (SD_BOTH) so the client cannot keep talking.
 *   2) The remaining operations (read/dump/qi/call/probe) are the unsafe
 *      primitives that were removed; they always report
 *      DIAGNOSTIC_DISABLED and are never executed.
 *   3) Anything else is not ours: return 0 so the caller decides.
 */
static int SurfaceRejectRequest(SOCKET s, const char *line, const char *op)
{
    int allowed;

    allowed = SurfaceAuthAllowed(line);
    if (!allowed) {
        SendLine(s, "{\"ok\":false,\"code\":\"SURFACE_AUTH_REQUIRED\",\"error\":\"auth required\"}");
        shutdown(s, SD_BOTH);
        return 1;
    }

    if (op) {
        char low[16];
        size_t i, n = strlen(op);
        if (n >= sizeof(low)) n = sizeof(low) - 1;
        for (i = 0; i < n; i++) low[i] = (char)tolower((unsigned char)op[i]);
        low[n] = 0;
        if (!strcmp(low, "read") || !strcmp(low, "dump") ||
            !strcmp(low, "qi")   || !strcmp(low, "call") ||
            !strcmp(low, "probe")) {
            SendLine(s, "{\"ok\":false,\"code\":\"SURFACE_DIAGNOSTIC_DISABLED\",\"error\":\"diagnostic disabled\"}");
            return 1;
        }
    }
    return 0;
}

#endif /* CW_AUTH_H */
