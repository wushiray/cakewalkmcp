/* cw_surface.c — a Cakewalk control-surface plugin that bridges to the MCP adapter.
 *
 * WHAT THIS IS
 *
 * SONAR discovers control surfaces by enumerating
 *   HKLM\SOFTWARE\Classes\CakewalkControlSurfaces
 * and CoCreateInstance-ing each subkey's CLSID. There is no allowlist, no
 * signature check and no membership gate on that path — verified by searching
 * the whole 63 MB Sonar.exe for the five shipped surface CLSIDs and finding
 * none of them, so the loader is purely data-driven off the registry.
 *
 * That makes a surface a legitimate, free extension point, and it is the only
 * way to reach several track properties at all: MUTE, SOLO, RECORD_ARM, INPUT,
 * OUTPUT, BANK, PATCH and the FX slot parameters. CAL covers some of them, the
 * menu commands cover others, and none of them covers routing or plugins.
 *
 * THE INTERFACE (recovered from the type library inside GenericSurface.dll)
 *
 *   IControlSurface   {933A0E58-A8FC-491E-9F4A-DC85B7CC1BE5}
 *   IControlSurface2  {1F4202FC-5755-473E-8B73-C627E21D7BE3}
 *   IControlSurface3  {58D9C925-31F4-4369-9308-EC85665BB7D1}
 *
 * The chain derives from IDispatch, not IUnknown, so the vtable is
 *   IUnknown(3) + IDispatch(4) + IControlSurface(9) + 2(10) + 3(18) = 44 slots.
 * A wrong shape here fails loudly at QueryInterface, which is why the load
 * probe exists: it exercises the contract before anything is registered.
 *
 * HOW A VALUE IS SET
 *
 * The surface holds the host object SONAR passes to Connect(), and calls
 *
 *     SetBaseTrack(n)                        pick the track
 *     SetTargetParam(mixerParam, value)      write the property
 *
 * SetTargetParam is a DIRECT SETTER on the host — it is not the "learn a MIDI
 * message" path (that is SetParamMidiMsg, used only when the user configures a
 * mapping by hand). So no user setup is required for any of this to work.
 *
 * The parameter enum, in declaration order, is the vocabulary:
 *   0 VOL   1 PAN   2 MUTE   3 SOLO   4 ARCHIVE  5 RECORD_ARM
 *   10 INPUT  12 OUTPUT  14 BANK  15 PATCH
 *   19 SEND_ENABLE  21 SEND_VOL  22 SEND_PAN
 *   26 FX  27 FX_COUNT  28 FX_PARAM_COUNT  29 FX_PARAM
 *
 * THE BRIDGE
 *
 * This DLL runs inside SONAR; the MCP adapter is a separate Node process. They
 * talk over a loopback TCP socket carrying line-delimited JSON — the same
 * request/reply shape as the project's three PowerShell bridges, chosen over a
 * named pipe because loopback is not token-gated, so it survives an elevation
 * mismatch between the two processes. SONAR itself already ships a loopback
 * listener, so this is a pattern the host uses.
 *
 * A WORKER THREAD owns the socket, so nothing here ever blocks SONAR's UI
 * thread. The shipped surfaces do the same (GenericSurface.dll imports
 * CreateThread, SetTimer and timeSetEvent), and the class is registered with
 * ThreadingModel="both", so this is within contract.
 *
 * FIRST-RUN DIAGNOSTICS
 *
 * Four things could not be settled without loading code into SONAR, so the DLL
 * records them and serves them over an op instead of guessing:
 *   - what IIDs the host object in Connect() answers to
 *   - whether RefreshSurface is ever called, and how often
 *   - whether SetBaseTrack is 0- or 1-based
 *   - whether the host object survives Disconnect
 * Call {"op":"diag"} to read them.
 *
 * NOTHING HERE IS REGISTERED BY BUILDING IT. Registration is a separate,
 * reversible step; see register.ps1.
 */

#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <winreg.h>
#include <tlhelp32.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <string.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "ole32.lib")

/* ------------------------------------------------------------------ ids -- */

/* This plugin's own CLSID. Deliberately NOT one of the five shipped GUIDs —
 * reusing one would collide with a system entry. */
static const GUID CLSID_CwSurface =
    {0x7C4A9B21,0x3D5E,0x4F8A,{0x9E,0x21,0x6B,0x4D,0x38,0x0A,0x7C,0x51}};

static const GUID IID_IControlSurface_p =
    {0x933A0E58,0xA8FC,0x491E,{0x9F,0x4A,0xDC,0x85,0xB7,0xCC,0x1B,0xE5}};
static const GUID IID_IControlSurface2_p =
    {0x1F4202FC,0x5755,0x473E,{0x8B,0x73,0xC6,0x27,0xE2,0x1D,0x7B,0xE3}};
static const GUID IID_IControlSurface3_p =
    {0x58D9C925,0x31F4,0x4369,{0x93,0x08,0xEC,0x85,0x66,0x5B,0xB7,0xD1}};

#define CW_DEFAULT_PORT 39177
#define CW_MAX_LINE     4096
#define CW_LOG_MAX      64

/* --------------------------------------------------------------- logging -- */

static CRITICAL_SECTION g_cs;
static int g_csReady = 0;

static char g_log[CW_LOG_MAX][256];
static int  g_logCount = 0;

/* The module handle, needed by LogToFile to locate the log beside the DLL.
 * Declared here rather than in the COM object's globals block further down
 * because logging runs from DllMain and from the worker thread, both of which
 * precede that block's position in the file. */
static HINSTANCE g_hInst = NULL;

/* A log file, because OutputDebugString was not enough.
 *
 * When the bridge port is unreachable there is exactly one question that
 * matters — did the worker bind or not — and reading the answer over the bridge
 * is impossible by definition. OutputDebugString needs a debugger attached,
 * which is not available here. So every line also goes to a file next to the
 * DLL, flushed each time, and the path is fixed so it can be read from outside
 * the SONAR process.
 *
 * Kept small and appended rather than rewritten: the file is a session trace,
 * and truncating it on load would destroy the previous run's evidence about the
 * very binding failure being investigated. */
static void LogToFile(const char *line)
{
    char path[MAX_PATH];
    HANDLE f;
    DWORD wrote;
    DWORD len;

    if (!g_hInst) return;
    len = GetModuleFileNameA(g_hInst, path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return;
    /* Replace the .dll suffix with .log beside it. */
    {
        char *dot = path + len;
        while (dot > path && *dot != '.' && *dot != '\\') dot--;
        if (*dot == '.' && dot > path) {
            lstrcpynA(dot, ".log", (int)(MAX_PATH - (dot - path)));
        }
    }

    f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    WriteFile(f, line, (DWORD)lstrlenA(line), &wrote, NULL);
    WriteFile(f, "\r\n", 2, &wrote, NULL);
    CloseHandle(f);
}

static void Logf(const char *fmt, ...)
{
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    _vsnprintf_s(buf, sizeof(buf), _TRUNCATE, fmt, ap);
    va_end(ap);

    if (g_csReady) EnterCriticalSection(&g_cs);
    /* Ring buffer: keep the newest, drop the oldest. A diagnostic that can
     * overflow into a crash would be worse than no diagnostic. */
    if (g_logCount < CW_LOG_MAX) {
        lstrcpynA(g_log[g_logCount], buf, sizeof(g_log[0]));
        g_logCount++;
    } else {
        int i;
        for (i = 1; i < CW_LOG_MAX; i++) lstrcpynA(g_log[i-1], g_log[i], sizeof(g_log[0]));
        lstrcpynA(g_log[CW_LOG_MAX-1], buf, sizeof(g_log[0]));
    }
    if (g_csReady) LeaveCriticalSection(&g_cs);

    LogToFile(buf);

    OutputDebugStringA("[cw_surface] ");
    OutputDebugStringA(buf);
    OutputDebugStringA("\n");
}

/* ----------------------------------------------------- parameter vocabulary - */

typedef struct { const char *name; int value; int writable; } ParamDef;

/* Values are the SONAR_MIXER_PARAM enum in declaration order, recovered from
 * the typelib. Names are the ones this project's tools use. */
static const ParamDef g_params[] = {
    {"VOL",          0,  1},
    {"PAN",          1,  1},
    {"MUTE",         2,  1},
    {"SOLO",         3,  1},
    {"ARCHIVE",      4,  1},
    {"RECORD_ARM",   5,  1},
    {"VOL_TRIM",     6,  1},
    {"PHASE",        7,  1},
    {"INPUT",       10,  1},
    {"OUTPUT",      12,  1},
    {"BANK",        14,  1},
    {"PATCH",       15,  1},
    {"KEY_OFFSET",  16,  1},
    {"VEL_OFFSET",  17,  1},
    {"SELECTED",    18,  1},
    {"SEND_ENABLE", 19,  1},
    {"SEND_VOL",    21,  1},
    {"SEND_PAN",    22,  1},
    {"INPUT_ECHO",  36,  1},
    {"FX",          26,  1},
    {"FX_PARAM",    29,  1},
    {NULL, 0, 0}
};

static const ParamDef *FindParam(const char *name)
{
    int i;
    if (!name) return NULL;
    for (i = 0; g_params[i].name; i++) {
        if (lstrcmpiA(g_params[i].name, name) == 0) return &g_params[i];
    }
    return NULL;
}

/* --------------------------------------------------------- the COM object -- */

/* Host-provided context. Filled in by Connect(); every method the host offers
 * is resolved through the IDispatch the host hands us, because the concrete
 * interface is not documented and could differ between builds. */
typedef struct {
    IDispatch *host;              /* the object from Connect(pUnknown, ...) */
    IUnknown  *rawHost;           /* the same pointer, un-QI'd — IDispatch is NOT
                                   * implemented by it, so this is what the
                                   * interface sweep works from */
    void     **vtable;            /* rawHost's vtable; attributable by address
                                   * even when no IID matches */
    HWND       hwndApp;
    int        connected;
    /* Diagnostics — see the header. These answer questions that cannot be
     * settled without a live host. */
    int        qiDispatch, qiUnknown, qiSurface, qiSurface2, qiSurface3;
    int        refreshCount;
    DWORD      firstRefreshTick, lastRefreshTick;
    int        setCalls, setFailures;
    /* The first interface the host accepted, and its vtable. Kept because this
     * is the object that can actually be used — unlike rawHost, which implements
     * nothing but the three HOST_IFACE IIDs. */
    IUnknown  *iface;
    void     **ifaceVtable;
    int        baseTrack;
    char       lastError[128];
} HostCtx;

static HostCtx g_host;
static LONG    g_refCount = 0;
static LONG    g_lockCount = 0;

/* Dispatch helper: call a named method on the host by DISPID. The host object
 * is an IDispatch, so GetIDsOfNames + Invoke is how every method is reached —
 * including SetTargetParam. Using late binding on purpose: it survives a
 * different vtable layout between builds. */
static HRESULT HostInvoke(const char *method, VARIANT *args, int nargs, VARIANT *out)
{
    OLECHAR *names[1];
    DISPID  dispid = 0;
    DISPPARAMS dp;
    HRESULT hr;
    WCHAR wmethod[128];

    if (!g_host.host) return E_FAIL;
    MultiByteToWideChar(CP_ACP, 0, method, -1, wmethod, 128);
    names[0] = wmethod;

    hr = IDispatch_GetIDsOfNames(g_host.host, &IID_NULL, names, 1,
                                LOCALE_USER_DEFAULT, &dispid);
    if (FAILED(hr)) {
        wsprintfA(g_host.lastError, "GetIDsOfNames(%s) hr=0x%08X", method, (unsigned)hr);
        return hr;
    }

    dp.rgvarg = args;
    dp.rgdispidNamedArgs = NULL;
    dp.cNamedArgs = 0;
    /* IDispatch passes arguments in REVERSE order. */
    dp.cArgs = (UINT)nargs;

    hr = IDispatch_Invoke(g_host.host, dispid, &IID_NULL, LOCALE_USER_DEFAULT,
                          DISPATCH_METHOD | DISPATCH_PROPERTYGET, &dp, out, NULL, NULL);
    if (FAILED(hr)) {
        wsprintfA(g_host.lastError, "Invoke(%s) hr=0x%08X", method, (unsigned)hr);
    }
    return hr;
}

/* --- IUnknown --- */
static HRESULT STDMETHODCALLTYPE Surf_QI(void *self, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IDispatch) ||
        IsEqualIID(riid, &IID_IControlSurface_p) ||
        IsEqualIID(riid, &IID_IControlSurface2_p) ||
        IsEqualIID(riid, &IID_IControlSurface3_p))
    {
        *ppv = self;
        InterlockedIncrement(&g_refCount);
        Logf("QI ok");
        return S_OK;
    }
    *ppv = NULL;
    return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE Surf_AddRef(void *self)
{ (void)self; return (ULONG)InterlockedIncrement(&g_refCount); }
static ULONG STDMETHODCALLTYPE Surf_Release(void *self)
{
    LONG n = InterlockedDecrement(&g_refCount);
    (void)self;
    return (ULONG)n;
}

/* --- IDispatch (the host reaches methods through this) --- */
static HRESULT STDMETHODCALLTYPE Surf_GetTypeInfoCount(void *s, UINT *p)
{ (void)s; if (p) *p = 0; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetTypeInfo(void *s, UINT i, LCID l, ITypeInfo **p)
{ (void)s; (void)i; (void)l; if (p) *p = NULL; return E_NOTIMPL; }
static HRESULT STDMETHODCALLTYPE Surf_GetIDsOfNames(void *s, REFIID r, LPOLESTR *n,
                                                    UINT c, LCID l, DISPID *d)
{ (void)s; (void)r; (void)n; (void)c; (void)l; (void)d; return E_NOTIMPL; }
static HRESULT STDMETHODCALLTYPE Surf_Invoke(void *s, DISPID d, REFIID r, LCID l, WORD f,
                                             DISPPARAMS *p, VARIANT *v, EXCEPINFO *e, UINT *a)
{ (void)s; (void)d; (void)r; (void)l; (void)f; (void)p; (void)v; (void)e; (void)a;
  return E_NOTIMPL; }

/* --- IControlSurface (slots 7..15) --- */

static HRESULT STDMETHODCALLTYPE Surf_GetStatusText(void *s, void *a) { (void)s;(void)a; return S_OK; }
/* --- MIDI in: the direction that was missed --------------------------------
 *
 * An earlier conclusion in this project was "all shipped surfaces only use
 * MIDI, and this one has no MIDI cable, so the surface route is closed". That
 * was half right and led away from the working mechanism.
 *
 * Re-reading the strings in GenericSurface.dll showed what the surface
 * interface is actually FOR. Its methods are
 *     SetParamMidiMsg(mixerParam, midiMsg)      tell SONAR which MIDI message
 *                                               drives which channel parameter
 *     GetTargetParam(nParamIx, pMixerParam, apdwParamNum)
 *                                               answer "what is the current
 *                                               value" for the host to display
 *     MidiInShortMsg(msg)                       receive MIDI FROM the host
 *
 * So a surface does not push values INTO SONAR through some hidden mixer
 * interface at all. It declares a mapping, SONAR feeds it MIDI, and the FADER
 * FOLLOWS THE MIDI. The write direction is MIDI, and it needs no host object.
 *
 * That makes MidiInShortMsg the load-bearing entry point, and it was a no-op
 * here. It now records what arrives so the bridge can prove SONAR is actually
 * sending to this surface — which is the one fact that decides whether the
 * MIDI route is open.
 */
#define CW_MIDI_LOG 64

typedef struct {
    DWORD msg;      /* the raw short message */
    DWORD tick;     /* GetTickCount when it arrived */
} MidiEvent;

static MidiEvent g_midiLog[CW_MIDI_LOG];
static volatile LONG g_midiCount = 0;
static volatile LONG g_midiTotal = 0;

/** Decode and record one short MIDI message.
 *
 * Also counts by status nibble, because "did anything at all arrive" and "what
 * kind of thing arrived" are different questions and the second one tells you
 * whether the host is sending control changes or clock. */
static void RecordMidi(DWORD m)
{
    LONG n = InterlockedIncrement(&g_midiTotal);
    LONG slot = InterlockedIncrement(&g_midiCount) - 1;
    if (slot < 0) slot = 0;
    if (slot >= CW_MIDI_LOG) slot = slot % CW_MIDI_LOG;
    g_midiLog[slot].msg = m;
    g_midiLog[slot].tick = GetTickCount();
    if (n <= 8 || (n % 200) == 0) {
        Logf("MIDI in #%ld: %02X %02X %02X", (long)n,
             (unsigned)(m & 0xFF), (unsigned)((m >> 8) & 0xFF), (unsigned)((m >> 16) & 0xFF));
    }
}

static HRESULT STDMETHODCALLTYPE Surf_MidiInShortMsg(void *s, DWORD m)
{
    (void)s;
    RecordMidi(m);
    return S_OK;
}
static HRESULT STDMETHODCALLTYPE Surf_MidiInLongMsg(void *s, void *a) { (void)s;(void)a; return S_OK; }


/* Connect is where the host object arrives — the single most informative
 * callback, so it probes the object and records what it answers to.
 *
 * MEASURED: the host object does NOT implement IDispatch. The log line is
 *     QI IDispatch -> 0x80004002      (E_NOINTERFACE)
 * so the late-bound route this file was written around — GetIDsOfNames then
 * Invoke, chosen to survive an unknown vtable layout — cannot reach anything.
 * That is why every write returned "not connected" even with a valid pointer.
 *
 * But the four E_NOINTERFACE lines here were later shown to mean only "not
 * these four IIDs", not "no interfaces at all": the host implements three IIDs
 * discovered by disassembling its own QueryInterface, and all three answer
 * S_OK. See g_probes below for the chain. The lesson is in the README: a
 * QueryInterface miss is evidence about the IID you tried, never about the
 * object.
 *
 * A typelib declares a parameter as IUnknown* when the real type is not in the
 * library, which is exactly what happened here: the recovered signature could
 * not name the interface, so it has to be discovered at runtime. This sweep QIs
 * the live pointer for every candidate and dumps the result, and `op:"probe"`
 * serves it. That turns "which interface is it" from a guess into a
 * measurement. */
typedef struct { const char *name; GUID iid; int ok; } IidProbe;

/* The three IIDs below are the real find.
 *
 * Everything before them was guesswork at the wrong layer: the shipped surface
 * IIDs, IDispatch, all E_NOINTERFACE. The way through was static analysis of
 * the host, and the chain was:
 *
 *   1. The log gave absolute addresses, and the module base made the vtable RVA
 *      exact: 0x1433505D8 - 0x140000000 = 0x33505D8.
 *   2. On disk that is a vtable in .rdata, and the pointer at [vtable-8] is an
 *      MSVC RTTICompleteObjectLocator. Following it to the TypeDescriptor gave
 *      the class name:  .?AVCCtrlSurface@@
 *   3. Its ClassHierarchyDescriptor listed the bases: CUnknown,
 *      INonDelegatingUnknown, CBaseObject, CMidiInputMonitor::CObserver,
 *      CCtrlSurfaceBase.
 *   4. Disassembling that vtable's slot 0 showed it is QueryInterface — it does
 *      `mov rax,[rdx]` and compares against IID pointers, which is also why the
 *      earlier blind call with (1, 2) crashed: 1 was dereferenced as an IID.
 *   5. The three IID addresses it compares against are the three below. They are
 *      what the object actually answers to.
 *
 * Naming them is still open — the IIDs sit in a pure-data region with no RTTI
 * nearby, and Sonar.exe is stripped — but naming is no longer required. A
 * QueryInterface with the RIGHT IID is a supported, safe operation, unlike the
 * blind vtable calls that crashed the host. */
static IidProbe g_probes[] = {
    {"IDispatch",        {0x00020400,0,0,{0xC0,0,0,0,0,0,0,0x46}}, 0},
    {"IControlSurface",  {0x933A0E58,0xA8FC,0x491E,{0x9F,0x4A,0xDC,0x85,0xB7,0xCC,0x1B,0xE5}}, 0},
    {"IControlSurface2", {0x1F4202FC,0x5755,0x473E,{0x8B,0x73,0xC6,0x27,0xE2,0x1D,0x7B,0xE3}}, 0},
    {"IControlSurface3", {0x58D9C925,0x31F4,0x4369,{0x93,0x08,0xEC,0x85,0x66,0x5B,0xB7,0xD1}}, 0},
    /* The three the host's own QueryInterface tests for, in the order it tests
     * them. Any of these answering S_OK is the interface this object exposes. */
    {"HOST_IFACE_1",     {0xED0C14F0,0x40F3,0x4459,{0x81,0x3C,0xCB,0x5B,0x5A,0x5E,0x49,0x58}}, 0},
    {"HOST_IFACE_2",     {0x85F8BB17,0x75F8,0x497F,{0x83,0x19,0xEF,0x33,0xA6,0x32,0xC3,0x80}}, 0},
    {"HOST_IFACE_3",     {0x55507DE1,0xC037,0x4682,{0xA4,0xEC,0x65,0xB1,0xD2,0xE8,0x6B,0x53}}, 0},
    {NULL, {0,0,0,{0,0,0,0,0,0,0,0}}, 0}
};

/* --- what CLASS is the host object? ----------------------------------------
 *
 * The module attribution settled WHERE the object lives (Sonar.exe) but not
 * WHAT it is. MSVC leaves that on disk: a vtable is preceded by a slot holding
 * -1 and, before that, a pointer to an RTTICompleteObjectLocator, which points
 * at a TypeDescriptor whose `name` field is the decorated class name. Reading
 * three pointers backwards from the vtable therefore yields a string like
 * ".?AVCMixerSomething@@" and the question is answered without guessing an IID.
 *
 * This is read-only memory inspection of the host's own process, done from
 * inside it. No patching, no writes. */
typedef struct {
    char className[256];   /* from the RTTI TypeDescriptor, if present */
    char raw[512];         /* the undecorated-looking part, for reporting */
    int  found;
    unsigned long locator; /* RTTICompleteObjectLocator address */
    unsigned long typeInfo;
} RttiIdentity;

static RttiIdentity g_rtti;

/* Defined below; ReadRtti needs it to resolve a module-relative RTTI pointer. */
static int ModuleOf(void *addr, char *name, int cap);

/* A TypeDescriptor after the vtable+spare pointer is:
 *     vfptr(8) spare(8) name[]  (on x64, with the name at +16)
 * The RTTICompleteObjectLocator is:
 *     signature(4) offset(4) cdOffset(4) pTypeDescriptor(4) pClassDescriptor(4)  (+padding)
 */
static void ReadRtti(void **vtable)
{
    ULONG_PTR addr = (ULONG_PTR)vtable;
    ULONG_PTR locator;
    ULONG_PTR pTypeDesc;
    const char *name;

    g_rtti.found = 0;
    g_rtti.className[0] = 0;
    g_rtti.raw[0] = 0;
    if (!vtable) return;

    /* vtable[-1] is the -1 marker, vtable[-2] the locator. Read them with
     * SEH-equivalent caution: this is host memory and a wrong guess must not
     * take the process down. IsBadReadPtr is deprecated but is exactly the
     * right tool here — a read-only probe of uncertain memory. */
    if (IsBadReadPtr(vtable - 2, sizeof(void *))) return;
    locator = (ULONG_PTR)vtable[-2];
    if (!locator) return;

    g_rtti.locator = (unsigned long)locator;
    if (IsBadReadPtr((void *)locator, 24)) return;

    /* pTypeDescriptor is the 4th DWORD in the locator on x64 (signature,
     * offset, cdOffset, pTypeDescriptor), stored as a 32-bit RVA-relative
     * value? No — MSVC stores it as a full pointer whose low 32 bits are used
     * only for the relative case. Read it as a 4-byte field and sign-extend,
     * which is what the layout actually holds for a normal (non-/GL) build. */
    {
        unsigned int td = *(unsigned int *)(locator + 12);
        pTypeDesc = (ULONG_PTR)(int)(long)td;
        /* Some builds store a 32-bit RVA; the pointer we just formed is inside
         * the module only if it lands in a plausible range, otherwise treat the
         * field as an RVA relative to the module base of the vtable. */
        if (pTypeDesc < 0x10000) {
            char modname[MAX_PATH];
            int mi = ModuleOf(vtable, modname, sizeof(modname));
            (void)mi;
            /* Fall back: use the image base of the module owning the vtable. */
            {
                ULONG_PTR base = 0;
                HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
                if (snap != INVALID_HANDLE_VALUE) {
                    MODULEENTRY32 me; me.dwSize = sizeof(me);
                    if (Module32First(snap, &me)) {
                        do {
                            ULONG_PTR b = (ULONG_PTR)me.modBaseAddr;
                            IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)b;
                            if (dos && dos->e_magic == IMAGE_DOS_SIGNATURE) {
                                IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((BYTE *)b + dos->e_lfanew);
                                if ((ULONG_PTR)vtable >= b && (ULONG_PTR)vtable < b + nt->OptionalHeader.SizeOfImage) {
                                    base = b; break;
                                }
                            }
                        } while (Module32Next(snap, &me));
                    }
                    CloseHandle(snap);
                }
                if (base) pTypeDesc = base + td;
            }
        }
    }

    if (!pTypeDesc || IsBadReadPtr((void *)pTypeDesc, 24)) return;
    g_rtti.typeInfo = (unsigned long)pTypeDesc;

    /* TypeDescriptor: vfptr(8) spare(8) name[] — x64 with std layout. */
    name = (const char *)(pTypeDesc + 16);
    if (IsBadReadPtr((void *)name, 1) || !*name) return;

    lstrcpynA(g_rtti.raw, name, sizeof(g_rtti.raw));
    /* Undecorate the common .?AV...@@ form into a readable class name: skip
     * ".?AV" and stop at the first "@". */
    if (name[0] == '.' && name[1] == '?' && name[2] == 'A') {
        const char *p = name + 4;
        int k = 0;
        while (*p && *p != '@' && k < (int)sizeof(g_rtti.className) - 1) {
            g_rtti.className[k++] = *p++;
        }
        g_rtti.className[k] = 0;
    } else {
        lstrcpynA(g_rtti.className, name, sizeof(g_rtti.className));
    }
    if (g_rtti.className[0]) g_rtti.found = 1;
    (void)addr;
}

/* --- the interfaces the host actually answers to ----------------------------
 *
 * MEASURED, and this is the breakthrough: the host object implements all three
 * of HOST_IFACE_1/2/3 — QueryInterface returns S_OK for each. Every earlier
 * failure was from testing the WRONG IIDs, which is why the sweep showed
 * E_NOINTERFACE across the board.
 *
 * The IIDs came from disassembling the host's own QueryInterface, not from
 * guessing: CCtrlSurface's slot 0 compares the incoming IID against three
 * addresses, and those three GUIDs are what it accepts.
 *
 * What remains is which slot of which interface is SetBaseTrack and which is
 * SetTargetParam. For that, each accepted interface's vtable is captured here —
 * the QI result is a distinct pointer per interface (multiple inheritance gives
 * each base its own vtable), so the addresses differ and can be walked. */
typedef struct {
    void *iface;        /* the pointer QI handed back */
    void *vtable;       /* its vtable */
    int   slots;        /* how many method slots it has, up to the cap */
    void *slot[24];     /* the slots themselves */
} AcceptedIface;

static AcceptedIface g_accepted[8];
static int g_acceptedCount = 0;

/* Defined further down; CaptureVtable uses it to stop at the first slot that is
 * not executable code (the end of a vtable is data or null). */
static int IsExecutable(void *addr);

/** Walk `vt` counting entries that point into executable memory. */
static void CaptureVtable(void *iface, void **vt)
{
    int i;
    AcceptedIface *a;
    if (g_acceptedCount >= 8 || !iface || !vt) return;
    a = &g_accepted[g_acceptedCount++];
    a->iface = iface;
    a->vtable = vt;
    a->slots = 0;
    for (i = 0; i < 24; i++) {
        void *fn = vt[i];
        if (!fn) break;
        if (!IsExecutable(fn)) break;
        a->slot[i] = fn;
        a->slots = i + 1;
    }
    Logf("accepted iface %d: ptr=%p vtable=%p slots=%d", g_acceptedCount - 1,
         iface, (void *)vt, a->slots);
}

/* --- which module owns an address? ------------------------------------------
 *
 * The interface sweep answered "not IDispatch, not a surface" and left the real
 * question open: WHICH interface is it? An IID cannot be guessed, but the
 * vtable can be attributed. Every loaded module is walked for an address range
 * containing both the host object's vtable and each of its function pointers,
 * which says whether the object is a C++ class inside Sonar.exe or something
 * from a DLL — and that narrows the search to one binary's symbols.
 */
typedef struct {
    char  module[MAX_PATH];   /* owning module path, basename only */
    char  slotModuleName[12][MAX_PATH];  /* cached per-slot module, filled once */
    void *vtable;             /* the object's vtable address */
    void *slots[12];          /* first 12 slots, for attribution */
    int   slotModule[12];     /* which module index each slot resolved to, -1 = none */
    int   vtableModule;       /* module index owning the vtable itself */
} HostIdentity;

static HostIdentity g_identity;

/** Which loaded module contains `addr`? -1 if none. Fills `name` when given.
 *
 * Uses a toolhelp snapshot rather than psapi: no extra import library, and it
 * reports the same base addresses. The module's extent comes from its own PE
 * headers, so a module whose SizeOfImage the snapshot does not carry is still
 * measured correctly. */
/* A cached module table, because the snapshot is the expensive part.
 *
 * The original walked a fresh toolhelp snapshot on every call. That is fine for
 * one lookup and fatal for many: `dump` asks about 24 addresses, and 24 full
 * module enumerations (Sonar.exe loads a few hundred DLLs) pushed the reply past
 * the client's timeout, so the op appeared to hang instead of answering. The
 * list is captured once and reused; module load/unload mid-session would make it
 * stale, and the cost of that is a wrong module name in a diagnostic, which is
 * acceptable where a timeout is not. */
typedef struct { ULONG_PTR base; ULONG_PTR end; char name[64]; } ModRange;
static ModRange g_mods[512];
static int g_modCount = -1;

static void LoadModuleTable(void)
{
    HANDLE snap;
    MODULEENTRY32 me;
    int n = 0;
    if (g_modCount >= 0) return;
    g_modCount = 0;
    snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snap == INVALID_HANDLE_VALUE) return;
    me.dwSize = sizeof(me);
    if (Module32First(snap, &me)) {
        do {
            IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)me.modBaseAddr;
            ULONG_PTR base = (ULONG_PTR)me.modBaseAddr;
            ULONG_PTR end = base + me.modBaseSize;
            const char *p, *q;
            if (n >= 512) break;
            if (dos && dos->e_magic == IMAGE_DOS_SIGNATURE) {
                IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((BYTE *)me.modBaseAddr + dos->e_lfanew);
                if (nt->Signature == IMAGE_NT_SIGNATURE) {
                    end = base + nt->OptionalHeader.SizeOfImage;
                }
            }
            g_mods[n].base = base;
            g_mods[n].end = end;
            lstrcpynA(g_mods[n].name, me.szModule, sizeof(g_mods[n].name));
            /* basename only, to keep the reply short */
            for (p = g_mods[n].name, q = g_mods[n].name; *p; p++) {
                if (*p == '\\' || *p == '/') q = p + 1;
            }
            if (q != g_mods[n].name) {
                int k = 0;
                while (*q && k < (int)sizeof(g_mods[n].name) - 1) g_mods[n].name[k++] = *q++;
                g_mods[n].name[k] = 0;
            }
            n++;
        } while (Module32Next(snap, &me));
    }
    CloseHandle(snap);
    g_modCount = n;
}

static int ModuleOf(void *addr, char *name, int cap)
{
    ULONG_PTR target = (ULONG_PTR)addr;
    int i;
    LoadModuleTable();
    for (i = 0; i < g_modCount; i++) {
        if (target >= g_mods[i].base && target < g_mods[i].end) {
            if (name && cap > 0) lstrcpynA(name, g_mods[i].name, cap);
            return i;
        }
    }
    return -1;
}


static HRESULT STDMETHODCALLTYPE Surf_Connect(void *self, IUnknown *pUnknown, HWND hwndApp)
{
    HRESULT hr;
    void *p = NULL;
    int i;
    (void)self;

    Logf("Connect: pUnknown=%p hwndApp=%p", (void*)pUnknown, (void*)hwndApp);

    g_host.hwndApp = hwndApp;
    g_host.host = NULL;
    g_host.rawHost = pUnknown;
    g_host.vtable = pUnknown ? *(void ***)pUnknown : NULL;
    /* A reconnect starts the interface capture over: leaving the previous run's
     * entries in place would report interfaces belonging to a released object. */
    g_acceptedCount = 0;

    if (!pUnknown) {
        Logf("Connect: host object is NULL — cannot set anything");
        lstrcpynA(g_host.lastError, "Connect got a NULL host object", sizeof(g_host.lastError));
        return E_POINTER;
    }

    /* Which interfaces does the host object actually offer? Unknown from the
     * typelib, so measured rather than assumed. */
    hr = IUnknown_QueryInterface(pUnknown, &IID_IDispatch, &p);
    g_host.qiDispatch = SUCCEEDED(hr);
    Logf("QI IDispatch -> 0x%08X", (unsigned)hr);
    if (SUCCEEDED(hr) && p) {
        g_host.host = (IDispatch *)p;   /* keep the reference */
        p = NULL;
    }

    hr = IUnknown_QueryInterface(pUnknown, &IID_IUnknown, &p);
    g_host.qiUnknown = SUCCEEDED(hr);
    if (p) { IUnknown_Release((IUnknown*)p); p = NULL; }

    hr = IUnknown_QueryInterface(pUnknown, &IID_IControlSurface_p, &p);
    g_host.qiSurface = SUCCEEDED(hr);
    if (p) { IUnknown_Release((IUnknown*)p); p = NULL; }

    hr = IUnknown_QueryInterface(pUnknown, &IID_IControlSurface2_p, &p);
    g_host.qiSurface2 = SUCCEEDED(hr);
    if (p) { IUnknown_Release((IUnknown*)p); p = NULL; }

    hr = IUnknown_QueryInterface(pUnknown, &IID_IControlSurface3_p, &p);
    g_host.qiSurface3 = SUCCEEDED(hr);
    if (p) { IUnknown_Release((IUnknown*)p); p = NULL; }

    g_host.connected = g_host.host ? 1 : 0;

    if (g_host.host) {
        /* Two harmless probe calls: does the host expose the mixer methods by
         * name, and what does SetBaseTrack report about its own indexing? */
        VARIANT out; VariantInit(&out);
        hr = HostInvoke("GetTrackCount", NULL, 0, &out);
        Logf("GetTrackCount -> 0x%08X val=%ld", (unsigned)hr, (long)out.lVal);
        VariantClear(&out);
    }

    /* Sweep the candidate IIDs against the live pointer, so "what interface is
     * this" becomes a measurement. The raw pointer and its vtable are recorded
     * too: even with no IID match, a vtable address can be attributed by
     * searching the loaded modules for it. */
    for (i = 0; g_probes[i].name; i++) {
        void *q = NULL;
        HRESULT qr = IUnknown_QueryInterface(pUnknown, &g_probes[i].iid, &q);
        g_probes[i].ok = SUCCEEDED(qr);
        Logf("probe %s -> 0x%08X", g_probes[i].name, (unsigned)qr);
        if (SUCCEEDED(qr) && q) {
            /* An accepted interface: remember it and walk its vtable. This is
             * the object's real usable surface — the three HOST_IFACE_* entries
             * are the first IIDs that ever came back S_OK. Its slots are what
             * SetBaseTrack and SetTargetParam have to be among. */
            CaptureVtable(q, *(void ***)q);
            if (!g_host.iface) {
                g_host.iface = q;      /* keep the first, for a write attempt */
                g_host.ifaceVtable = *(void ***)q;
            } else {
                IUnknown_Release((IUnknown *)q);
            }
        } else if (q) {
            IUnknown_Release((IUnknown *)q);
        }
    }

    /* Attribute the vtable and its first slots to loaded modules. The IID sweep
     * above can only say "not one of these"; this says WHERE the object lives,
     * which is the fact that narrows an unknown interface to one binary. */
    if (g_host.vtable) {
        g_identity.vtable = (void *)g_host.vtable;
        g_identity.vtableModule = ModuleOf((void *)g_host.vtable,
                                           g_identity.module, sizeof(g_identity.module));
        Logf("vtable %p is in module[%d] %s", (void *)g_host.vtable,
             g_identity.vtableModule, g_identity.module[0] ? g_identity.module : "(unattributed)");

        for (i = 0; i < 12; i++) {
            char mname[MAX_PATH];
            void *fn = (void *)g_host.vtable[i];
            g_identity.slots[i] = fn;
            mname[0] = 0;
            if (!fn) { g_identity.slotModule[i] = -1; g_identity.slotModuleName[i][0] = 0; continue; }
            g_identity.slotModule[i] = ModuleOf(fn, mname, sizeof(mname));
            lstrcpynA(g_identity.slotModuleName[i], mname, MAX_PATH);
            Logf("  slot %2d = %p in %s", i, fn,
                 mname[0] ? mname : "(unattributed)");
        }

        /* And the class name, from the RTTI the compiler left in the image. */
        ReadRtti(g_host.vtable);
        Logf("RTTI class: %s", g_rtti.found ? g_rtti.className : "(none)");
    }

    /* A surface can still be driven even with no host object: the old surfaces
     * write through MIDI, and this plugin has a real MIDI cable. Marking the
     * link usable regardless of the QI result means a MIDI-only path stays open
     * rather than being blocked by a missing IDispatch. */
    g_host.connected = 1;

    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Surf_Disconnect(void *s)
{
    (void)s;
    Logf("Disconnect");
    if (g_host.host) { IDispatch_Release(g_host.host); g_host.host = NULL; }
    g_host.rawHost = NULL;
    g_host.vtable = NULL;
    g_host.connected = 0;
    return S_OK;
}

/* The host's periodic tick. Counting it answers "is there a heartbeat, and how
 * fast" — the question that decides whether a queue can be serviced here or
 * needs the worker thread. */
static HRESULT STDMETHODCALLTYPE Surf_RefreshSurface(void *s, DWORD fdw, DWORD cookie)
{
    DWORD now = GetTickCount();
    (void)s; (void)cookie;
    if (g_host.refreshCount == 0) g_host.firstRefreshTick = now;
    g_host.lastRefreshTick = now;
    g_host.refreshCount++;
    if (g_host.refreshCount <= 3 || (g_host.refreshCount % 500) == 0) {
        Logf("RefreshSurface #%d flags=0x%08X", g_host.refreshCount, (unsigned)fdw);
    }
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Surf_GetNoEchoMask(void *s, void *a) { (void)s;(void)a; return S_OK; }

static HRESULT STDMETHODCALLTYPE Surf_GetVersion(void *s, int *maj, int *min, int *rev, int *bld)
{
    (void)s;
    /* The shipped surfaces report 1.0.0.x. Inventing a number risks a range
     * check rejecting us, so copy the shape. */
    if (maj) *maj = 1; if (min) *min = 0; if (rev) *rev = 0; if (bld) *bld = 1;
    return S_OK;
}

static HRESULT STDMETHODCALLTYPE Surf_GetNoEchoStatusMessages(void *s, void *a) { (void)s;(void)a; return S_OK; }

/* Reading a parameter — used to confirm a write landed, which no other path in
 * this adapter can do for routing or patch. */
static HRESULT STDMETHODCALLTYPE Surf_GetTargetParam(void *s, int ix, int *param, DWORD *num)
{
    (void)s; (void)ix;
    if (param) *param = -1;
    if (num) *num = 0;
    return S_OK;
}

/* --- behavioural slot probing: TRIED, AND REMOVED --------------------------
 *
 * The metadata route ran out. The interface sweep says "not IDispatch, not a
 * surface"; module attribution says "somewhere in Sonar.exe"; the RTTI locator
 * did not resolve, and the class name could not be recovered. So the next idea
 * was to identify the setter by BEHAVIOUR — call each vtable slot with
 * (self, paramEnum, value) and see which one moves a track's mute state,
 * without needing its name.
 *
 * It was implemented, run twice, and removed. Both runs are worth recording
 * because together they show this route cannot be made safe:
 *
 * RUN 1 — deadlocked the bridge. Calling slot 0 from the bridge's own worker
 * thread never returned. SONAR survived (project intact, menu working, document
 * not even modified) but every later request timed out: the single worker was
 * still inside SONAR.
 *
 * RUN 2 — the fix for run 1 was correct, and the probe still crashed SONAR.
 * Each call was moved onto a one-shot thread with a timeout, which worked
 * exactly as intended: nine slots reported "did not return" without touching
 * the bridge, and three returned values consistent with the IUnknown prefix
 * (slot 1 = 6, slot 2 = 5 — reference counts; slot 3 = a heap pointer). The
 * bridge stayed alive and answered `ping` afterwards.
 *
 *   But SONAR then raised its own crash dialog: C0000005 access violation,
 *   written to MiniDumps\Untitled_10162026_020341.dmp.
 *
 * So isolation protected the BRIDGE, not the HOST. The dangerous mutation
 * happened inside SONAR on a thread that could not be recalled, and SONAR took
 * the damage. Recovery was available (the dialog offers to save a recovery
 * copy; "否" was chosen so no user project file was written) but the process
 * was gone.
 *
 * THE CONCLUSION, and the reason none of this code remains:
 *
 *   An unknown C++ interface cannot be discovered by calling it. Every guard
 *   available here — memory protection, thread isolation, timeouts — protects
 *   the caller, never the callee. A wrong-but-executable slot runs with full
 *   privileges inside the host and can do anything, and this host will crash on
 *   the wrong guess rather than returning an error.
 *
 * `IsExecutable` is kept: it is cheap and it is the right first check for any
 * future work that has a code pointer with a KNOWN signature. It is explicitly
 * NOT a safety net, and the comment on it says so.
 *
 * Where that leaves the mixer write path is documented in the README. Short
 * version: the surface plugin loads, registers, appears in the picker, is
 * instantiated by SONAR, and its RefreshSurface heartbeat runs — but the object
 * SONAR passes to Connect exposes no interface that carries SetTargetParam, and
 * guessing at its vtable crashes the host. The accessibility path covers the
 * same controls and is the one that works.
 */
/** Is `addr` inside a page the OS will let us execute?
 *
 * Kept despite the sweep being removed, because it is the right first check for
 * any future work with a code pointer and it is cheap. It is NOT a safety
 * guarantee: the sweep that used it deadlocked SONAR's thread anyway, because
 * an executable function can still be the wrong function. See the block comment
 * above for what that cost. */
static int IsExecutable(void *addr)
{
    MEMORY_BASIC_INFORMATION mbi;
    if (!addr) return 0;
    if (VirtualQuery(addr, &mbi, sizeof(mbi)) == 0) return 0;
    if (mbi.State != MEM_COMMIT) return 0;
    if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return 0;
    return (mbi.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ |
                           PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) ? 1 : 0;
}

/* THE WRITE. Called by the worker thread when a "set" request arrives, so the
 * host object is touched from a thread other than SONAR's UI thread — which is
 * within contract because the class is registered ThreadingModel="both". */
static int SetOneParam(int track, int paramEnum, DWORD value)
{
    VARIANT args[2];
    VARIANT out;
    HRESULT hr;

    /* Two distinct refusals, and the difference matters: "no host at all" means
     * the surface was never added in Preferences, while "host but no IDispatch"
     * means the interface has to be reached by vtable instead. Collapsing them
     * into one message is what let the first attempt look like a setup problem
     * when it was a design problem. */
    if (!g_host.rawHost) {
        lstrcpynA(g_host.lastError,
                  "no host object: add the surface in Preferences > MIDI > Control Surfaces",
                  sizeof(g_host.lastError));
        return 0;
    }
    if (!g_host.host) {
        /* Neither name-calling route works: the host has no IDispatch, and the
         * interfaces it DOES expose (three of them, captured in g_accepted) have
         * not been mapped to SetBaseTrack/SetTargetParam. Saying "the host has
         * no interfaces" would now be false — see the comment on g_probes. */
        wsprintfA(g_host.lastError,
                  "host object has no IDispatch and its %d accepted interface(s) are not yet "
                  "mapped to SetBaseTrack/SetTargetParam; see op:\"probe\" for their vtables",
                  g_acceptedCount);
        return 0;
    }

    /* Pick the track first — SetTargetParam is relative to the base track. */
    VariantInit(&args[0]);
    args[0].vt = VT_I4;
    args[0].lVal = track;
    hr = HostInvoke("SetBaseTrack", args, 1, NULL);
    if (FAILED(hr)) {
        Logf("SetBaseTrack(%d) failed hr=0x%08X", track, (unsigned)hr);
        return 0;
    }
    g_host.baseTrack = track;

    /* Then write the property. IDispatch takes args in reverse, so the array is
     * [value, paramEnum] for a call of SetTargetParam(paramEnum, value). */
    VariantInit(&args[0]);
    args[0].vt = VT_I4;
    args[0].lVal = (LONG)value;
    VariantInit(&args[1]);
    args[1].vt = VT_I4;
    args[1].lVal = (LONG)paramEnum;

    VariantInit(&out);
    hr = HostInvoke("SetTargetParam", args, 2, &out);
    VariantClear(&out);

    if (FAILED(hr)) {
        g_host.setFailures++;
        Logf("SetTargetParam(param=%d,val=%lu) hr=0x%08X",
             paramEnum, (unsigned long)value, (unsigned)hr);
        return 0;
    }
    g_host.setCalls++;
    return 1;
}

static HRESULT STDMETHODCALLTYPE Surf_SetTargetParam(void *s, int p, DWORD n) { (void)s;(void)p;(void)n; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_SetParamMidiMsg(void *s, void *a) { (void)s;(void)a; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetParamMidiMsg(void *s, void *a) { (void)s;(void)a; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_SetDynamicControlType(void *s, void *a) { (void)s;(void)a; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetDynamicControlType(void *s, void *a) { (void)s;(void)a; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_SetDynamicParamMidiMsg(void *s, void *a) { (void)s;(void)a; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetDynamicParamMidiMsg(void *s, void *a) { (void)s;(void)a; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_SetMetaMidiMsg(void *s, void *a) { (void)s;(void)a; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetMetaMidiMsg(void *s, void *a) { (void)s;(void)a; return S_OK; }

/* --- IControlSurface3 — the bank/track model (slots 25..42) --- */
static HRESULT STDMETHODCALLTYPE Surf_SetBankWidth(void *s, int w)
{ (void)s; Logf("SetBankWidth(%d)", w); return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetBankWidth(void *s, int *w)
{ (void)s; if (w) *w = 1; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetAuxBusCount(void *s, int *c)
{ (void)s; if (c) *c = 0; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetBaseTrack(void *s, int *t)
{ (void)s; if (t) *t = g_host.baseTrack; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_SetBaseTrack(void *s, int t)
{ (void)s; g_host.baseTrack = t; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_GetTrackCount(void *s, int *c)
{ (void)s; if (c) *c = 0; return S_OK; }
static HRESULT STDMETHODCALLTYPE Surf_NoOp1(void *s) { (void)s; return S_OK; }

#define NOOP_METHOD(name) static HRESULT STDMETHODCALLTYPE name(void *s) { (void)s; return S_OK; }
NOOP_METHOD(Surf_GetSupportsDynamicMapping)
NOOP_METHOD(Surf_GetMappingName)
NOOP_METHOD(Surf_GetMappedParamName)
NOOP_METHOD(Surf_GetACTEnable)
NOOP_METHOD(Surf_SetACTEnable)
NOOP_METHOD(Surf_GetACTExclusive)
NOOP_METHOD(Surf_SetACTExclusive)
NOOP_METHOD(Surf_GetACTLockContext)
NOOP_METHOD(Surf_SetACTLockContext)
NOOP_METHOD(Surf_SetLearnEnable)
NOOP_METHOD(Surf_GetLearnEnable)
NOOP_METHOD(Surf_OnContextSwitch)

/* ------------------------------------------------------------- the vtable -- */

/* 44 slots: IUnknown(3) + IDispatch(4) + 9 + 10 + 18. The count matters — a
 * short vtable makes the host call past the end and crash, so the missing I2/I3
 * methods are filled with no-ops rather than omitted. */
/* The object COM receives — one word, and that word IS the vtable pointer.
 *
 * A COM object's first word is its vtable pointer, so CreateInstance must hand
 * back the address of a word holding &g_vtbl[0], not the address of a separate
 * variable that happens to point at the vtable.
 *
 * That was a real bug here, and it is worth recording because it is invisible
 * to QueryInterface. With
 *     static const void **g_obj = g_vtbl;
 *     *ppv = (void *)&g_obj;
 * COM's object is &g_obj, so obj[0] reads g_obj — the vtable pointer, correct,
 * which is why every QI in the earlier probes passed. But obj[7], obj[10], ...
 * then read whatever sits AFTER g_obj in memory rather than the vtable. The
 * slot dump showed NULLs at 8, 12, 13, 14, 15 and a real code pointer at 10 by
 * luck; SONAR would have called a garbage address on its first method call.
 * The load probe caught it purely because it printed the slots. */
static void *g_objVtbl[1];

static const void *g_vtbl[44];

static void InitVtbl(void)
{
    g_vtbl[0]  = (const void *)Surf_QI;
    g_vtbl[1]  = (const void *)Surf_AddRef;
    g_vtbl[2]  = (const void *)Surf_Release;
    g_vtbl[3]  = (const void *)Surf_GetTypeInfoCount;
    g_vtbl[4]  = (const void *)Surf_GetTypeInfo;
    g_vtbl[5]  = (const void *)Surf_GetIDsOfNames;
    g_vtbl[6]  = (const void *)Surf_Invoke;
    /* IControlSurface */
    g_vtbl[7]  = (const void *)Surf_GetStatusText;
    g_vtbl[8]  = (const void *)Surf_MidiInShortMsg;
    g_vtbl[9]  = (const void *)Surf_MidiInLongMsg;
    g_vtbl[10] = (const void *)Surf_Connect;
    g_vtbl[11] = (const void *)Surf_Disconnect;
    g_vtbl[12] = (const void *)Surf_RefreshSurface;
    g_vtbl[13] = (const void *)Surf_GetNoEchoMask;
    g_vtbl[14] = (const void *)Surf_GetVersion;
    g_vtbl[15] = (const void *)Surf_GetNoEchoStatusMessages;
    /* IControlSurface2 */
    g_vtbl[16] = (const void *)Surf_GetTargetParam;
    g_vtbl[17] = (const void *)Surf_SetTargetParam;
    g_vtbl[18] = (const void *)Surf_SetParamMidiMsg;
    g_vtbl[19] = (const void *)Surf_GetParamMidiMsg;
    g_vtbl[20] = (const void *)Surf_SetDynamicControlType;
    g_vtbl[21] = (const void *)Surf_GetDynamicControlType;
    g_vtbl[22] = (const void *)Surf_SetDynamicParamMidiMsg;
    g_vtbl[23] = (const void *)Surf_GetDynamicParamMidiMsg;
    g_vtbl[24] = (const void *)Surf_SetMetaMidiMsg;
    g_vtbl[25] = (const void *)Surf_GetMetaMidiMsg;
    /* IControlSurface3 */
    g_vtbl[26] = (const void *)Surf_SetBankWidth;
    g_vtbl[27] = (const void *)Surf_GetBankWidth;
    g_vtbl[28] = (const void *)Surf_GetAuxBusCount;
    g_vtbl[29] = (const void *)Surf_GetBaseTrack;
    g_vtbl[30] = (const void *)Surf_SetBaseTrack;
    g_vtbl[31] = (const void *)Surf_GetTrackCount;
    g_vtbl[32] = (const void *)Surf_GetSupportsDynamicMapping;
    g_vtbl[33] = (const void *)Surf_GetMappingName;
    g_vtbl[34] = (const void *)Surf_GetMappedParamName;
    g_vtbl[35] = (const void *)Surf_GetACTEnable;
    g_vtbl[36] = (const void *)Surf_SetACTEnable;
    g_vtbl[37] = (const void *)Surf_GetACTExclusive;
    g_vtbl[38] = (const void *)Surf_SetACTExclusive;
    g_vtbl[39] = (const void *)Surf_GetACTLockContext;
    g_vtbl[40] = (const void *)Surf_SetACTLockContext;
    g_vtbl[41] = (const void *)Surf_SetLearnEnable;
    g_vtbl[42] = (const void *)Surf_GetLearnEnable;
    g_vtbl[43] = (const void *)Surf_OnContextSwitch;

    /* The object is one word: its vtable pointer. See g_objVtbl's comment. */
    g_objVtbl[0] = (void *)g_vtbl;
}
/* ------------------------------------------------------------ TCP bridge -- */

static volatile LONG g_stopWorker = 0;
static HANDLE g_workerThread = NULL;
static SOCKET g_listen = INVALID_SOCKET;
static int    g_port = CW_DEFAULT_PORT;

/* One JSON field out of a line. Deliberately tiny and strict: the protocol is
 * flat, and a real parser would be more code than the messages justify. */
static int JsonInt(const char *line, const char *key, int dflt)
{
    char pat[64];
    const char *p;
    wsprintfA(pat, "\"%s\"", key);
    p = strstr(line, pat);
    if (!p) return dflt;
    p = strchr(p + lstrlenA(pat), ':');
    if (!p) return dflt;
    p++;
    while (*p == ' ') p++;
    return atoi(p);
}

/* A 64-bit variant, because addresses do not fit in an int.
 *
 * JsonInt uses atoi, which truncates anything above INT_MAX and returns a
 * negative number — and every useful address on x64 is above it. Using JsonInt
 * for `addr` would silently turn 0x433505d8 into a garbage pointer rather than
 * failing, which is the worst of both outcomes. */
static ULONG_PTR JsonU64(const char *line, const char *key, ULONG_PTR dflt)
{
    char pat[64];
    const char *p;
    ULONG_PTR v = 0;
    int digits = 0;
    wsprintfA(pat, "\"%s\"", key);
    p = strstr(line, pat);
    if (!p) return dflt;
    p = strchr(p + lstrlenA(pat), ':');
    if (!p) return dflt;
    p++;
    while (*p == ' ') p++;
    /* The value may be quoted. The client sends addresses as hex STRINGS
     * (because a 64-bit value does not survive as a JSON number), so a parser
     * that only reads bare digits rejects exactly the input it produces. */
    if (*p == '"') p++;
    /* Accept decimal and 0x-prefixed hex, since a caller reading an address out
     * of a previous reply will have it in hex. */
    if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
        p += 2;
        while (*p) {
            int d;
            char c = *p;
            if (c >= '0' && c <= '9') d = c - '0';
            else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
            else break;
            v = (v << 4) | (ULONG_PTR)d;
            digits++; p++;
        }
    } else {
        while (*p >= '0' && *p <= '9') {
            v = v * 10 + (ULONG_PTR)(*p - '0');
            digits++; p++;
        }
    }
    return digits ? v : dflt;
}

static int HexVal(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Parse a GUID from 32 hex digits, with or without dashes or braces.
 *
 * Registry order: Data1 (8 digits), Data2 (4), Data3 (4), then the last two
 * fields as they appear in writing — but those last 8 bytes are stored on the
 * wire in reverse byte order relative to how they are printed, which is the
 * detail that makes a hand-rolled parser produce a GUID that never matches. */
static int ParseGuid(const char *s, GUID *out)
{
    unsigned int b[16];
    int n = 0;
    const char *p = s;
    if (!s || !out) return -1;
    while (*p && n < 16) {
        int hi, lo;
        char c = *p;
        if (c == '{' || c == '}' || c == '-' || c == ' ') { p++; continue; }
        hi = HexVal(c);
        if (hi < 0) return -1;
        lo = HexVal(p[1]);
        if (lo < 0) return -1;
        b[n++] = (unsigned int)((hi << 4) | lo);
        p += 2;
    }
    if (n != 16) return -1;
    /* Data1/2/3 are little-endian in memory; Data4 is byte order as printed. */
    out->Data1 = (unsigned long)(b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24));
    out->Data2 = (unsigned short)(b[4] | (b[5] << 8));
    out->Data3 = (unsigned short)(b[6] | (b[7] << 8));
    {
        int i;
        for (i = 0; i < 8; i++) out->Data4[i] = (unsigned char)b[8 + i];
    }
    return 0;
}


static int JsonStr(const char *line, const char *key, char *out, int cap)
{
    char pat[64];
    const char *p, *q;
    int n;
    wsprintfA(pat, "\"%s\"", key);
    p = strstr(line, pat);
    if (!p) return 0;
    p = strchr(p + lstrlenA(pat), ':');
    if (!p) return 0;
    p = strchr(p, '"');
    if (!p) return 0;
    p++;
    q = strchr(p, '"');
    if (!q) return 0;
    n = (int)(q - p);
    if (n >= cap) n = cap - 1;
    memcpy(out, p, n);
    out[n] = 0;
    return 1;
}

static void SendLine(SOCKET s, const char *text)
{
    /* lstrlen + memcpy, NOT wsprintfA("%s\n"). Two hard defects hid here:
     *
     * 1. wsprintfA is user32's reduced printf and its output is capped at 1024
     *    characters - a hard cap in the implementation, not a buffer size. Replies
     *    up to CW_MAX_LINE (4096) were silently truncated, and because the\n
     *    was part of the formatted output the truncated line often arrived
     *    WITHOUT its terminator, which the client reads as a dead plugin. This
     *    is the likely true cause of the historical "probe hangs" symptom that
     *    was blamed on length guards in the handlers.
     * 2. wsprintfA INTERPRETS a format string. "%s" with text as the argument
     *    is safe from %-injection, but one future caller writing
     *    SendLine(s, someUserText) turns it into a format-string bug. A copy
     *    loop has no format at all, so the whole class is gone.
     */
    int n = lstrlenA(text);
    char buf[CW_MAX_LINE + 2];
    if (n > CW_MAX_LINE) n = CW_MAX_LINE;          /* already guarded upstream */
    memcpy(buf, text, n);
    buf[n++] = '\n';
    /* send may take fewer bytes than asked even on loopback; loop. */
    {
        int sent = 0;
        while (sent < n) {
            int k = send(s, buf + sent, n - sent, 0);
            if (k == SOCKET_ERROR) return;
            sent += k;
        }
    }
}

/* Copy `in` into `out` as the contents of a JSON string.
 *
 * This exists because the naive version shipped and broke: an error message
 * containing a bare `"` (the text `op:"probe"` in one of them) produced
 *     {"ok":false,...,"error":"...see op:"probe" for..."}
 * which is invalid JSON. The Node client then reported "sent unparseable JSON"
 * instead of the actual error, so the real message — the one explaining that
 * the host object has no IDispatch — never reached the caller.
 *
 * A protocol that mangles its own error messages is worse than one that has
 * none, so escaping is not optional here.
 */
static int JsonEscape(char *out, int cap, const char *in)
{
    int n = 0;
    if (cap <= 1) return 0;
    for (; *in && n < cap - 2; in++) {
        unsigned char c = (unsigned char)*in;
        if (c == '"' || c == '\\') {
            if (n >= cap - 3) break;
            out[n++] = '\\';
            out[n++] = (char)c;
        } else if (c == '\n') {
            if (n >= cap - 3) break;
            out[n++] = '\\'; out[n++] = 'n';
        } else if (c == '\r') {
            if (n >= cap - 3) break;
            out[n++] = '\\'; out[n++] = 'r';
        } else if (c == '\t') {
            if (n >= cap - 3) break;
            out[n++] = '\\'; out[n++] = 't';
        } else if (c < 0x20) {
            /* Other control characters: emit a space rather than raw bytes. */
            out[n++] = ' ';
        } else {
            out[n++] = (char)c;
        }
    }
    out[n] = 0;
    return n;
}

/* ---- watched calls -------------------------------------------------------
 *
 * A call into a method whose behaviour has been read but never executed is the
 * one operation in this file that can take the host down. It is therefore run
 * on a thread of its own, and the caller waits on it with a timeout instead of
 * waiting on the callee.
 *
 * What this does and does not buy, stated plainly: if the callee returns, the
 * HRESULT is reported. If the callee blocks, the wait expires and the reply
 * says `completed:false` while the bridge keeps serving — which is the outcome
 * that matters, because the previous failure mode was a worker that died
 * silently and left every later request timing out with no explanation. If the
 * callee faults, the fault happens on the spare thread and takes the process
 * down anyway; a thread boundary is not a fault boundary. The value here is
 * diagnosability on the common failure (a hang), not immunity on the rare one.
 */
typedef HRESULT (STDMETHODCALLTYPE *Hresult4Fn)(void *, int, int, int);

typedef struct {
    Hresult4Fn fn;
    void *obj;
    int a1, a2, a3;
    HRESULT hr;
    volatile LONG done;
} CallJob;

/* One job, not one per request: the worker is single-threaded, so a second
 * concurrent call cannot happen, and a call that outlives its timeout still
 * needs a live place to write its result. */
static CallJob g_job;

/* Kept well under the client's timeout so a slow call still produces a reply
 * rather than a client-side timeout that hides the result. */
#define kCallTimeoutMs 2500

static DWORD WINAPI CallThread(LPVOID arg)
{
    CallJob *job = (CallJob *)arg;
    job->hr = job->fn(job->obj, job->a1, job->a2, job->a3);
    InterlockedExchange(&job->done, 1);
    return 0;
}

static void RunCallWatched(CallJob *job, DWORD timeoutMs)
{
    HANDLE h = CreateThread(NULL, 0, CallThread, job, 0, NULL);
    if (!h) {
        /* No thread, no call. Returning without invoking is the safe failure:
         * the reply then reports completed:false and E_UNEXPECTED, which is
         * distinguishable from any HRESULT the method itself could return. */
        Logf("CallThread: CreateThread failed err=%lu", GetLastError());
        return;
    }
    WaitForSingleObject(h, timeoutMs);
    if (!job->done) {
        Logf("call slot did not return within %lu ms — still running, reply sent anyway",
             (unsigned long)timeoutMs);
        /* The thread is deliberately not terminated and its handle not closed:
         * killing a thread inside the host's lock is worse than leaking it, and
         * closing the handle would free a stack the thread is still using. */
        return;
    }
    CloseHandle(h);
}

#include "surface_auth.h"

static void HandleLine(SOCKET s, char *line)
{
    char op[32];
    char paramName[32];
    char reply[CW_MAX_LINE];
    const ParamDef *pd;
    int track, value, i, n;


    if (!JsonStr(line, "op", op, sizeof(op))) {
        SendLine(s, "{\"ok\":false,\"error\":\"missing op\"}");
        return;
    }

    if (SurfaceRejectRequest(s, line, op)) return;

    if (lstrcmpiA(op, "ping") == 0) {
        SendLine(s, "{\"ok\":true,\"pong\":true}");
        return;
    }

    if (lstrcmpiA(op, "status") == 0) {
        sprintf(reply,
            "{\"ok\":true,\"connected\":%d,\"port\":%d,\"refs\":%d,"
            "\"refresh\":%d,\"sets\":%d,\"failures\":%d}",
            g_host.connected, g_port, (int)g_refCount,
            g_host.refreshCount, g_host.setCalls, g_host.setFailures);
        SendLine(s, reply);
        return;
    }

    /* The first-run diagnostics — the four things that cannot be settled
     * without a live host. */

    if (lstrcmpiA(op, "midi") == 0) {
        /* What MIDI has SONAR sent to this surface?
         *
         * This is the decisive measurement for the MIDI route. If the count is
         * non-zero, the host is feeding this surface and the mapping approach in
         * SetParamMidiMsg is viable; if it stays zero after notes and CC are
         * played at the enabled port, then the host never routes MIDI here and
         * the route is closed regardless of the interface question. */
        LONG total = g_midiTotal;
        LONG count = g_midiCount;
        LONG shown = count < CW_MIDI_LOG ? count : CW_MIDI_LOG;
        LONG i;
        n = sprintf(reply, "{\"ok\":true,\"total\":%ld,\"kept\":%ld,\"events\":[",
                      (long)total, (long)shown);
        /* The length guard is not optional: 64 events at ~120 bytes each is
         * ~7.7 KB, well past CW_MAX_LINE, and an unterminated line is
         * indistinguishable from a dead plugin on the client side. The reply
         * stops early and reports how many it managed to include. */
        {
            int emitted = 0;
            for (i = 0; i < shown && n < CW_MAX_LINE - 200; i++) {
                DWORD m = g_midiLog[i].msg;
                n += sprintf(reply + n,
                    "%s{\"raw\":%lu,\"status\":\"0x%02X\",\"d1\":%u,\"d2\":%u,\"tick\":%lu}",
                    i ? "," : "", (unsigned long)m,
                    (unsigned)(m & 0xFF), (unsigned)((m >> 8) & 0xFF),
                    (unsigned)((m >> 16) & 0xFF), (unsigned long)g_midiLog[i].tick);
                emitted++;
            }
            sprintf(reply + n, "],\"emitted\":%d}", emitted);
        }
        SendLine(s, reply);
        return;
    }

    if (lstrcmpiA(op, "dump") == 0) {
        /* Read the host object's own memory, without calling anything.
         *
         * This is the safe half of introspection and it was not tried before the
         * risky half. `SetTargetParam` in the shipped plugin reads `this+0xF0`,
         * so the host's member layout is worth knowing: a pointer at some offset
         * that resolves into Sonar.exe's .data would identify the mixer or the
         * project object it holds, and the offset is what any later call would
         * need anyway.
         *
         * Reads only. No calls, no writes, no faults on a valid object. Length
         * and offset are bounded so a bad request cannot walk off the end. */
        int off = JsonInt(line, "offset", 0);
        int want = JsonInt(line, "count", 24);
        int k;
        if (!g_host.rawHost) {
            SendLine(s, "{\"ok\":false,\"error\":\"no host object connected\"}");
            return;
        }
        if (off < 0) off = 0;
        if (off > 0x2000) off = 0x2000;
        if (want < 1) want = 1;
        if (want > 32) want = 32;
        if (IsBadReadPtr((char *)g_host.rawHost + off, (size_t)(want * 8))) {
            SendLine(s, "{\"ok\":false,\"error\":\"unreadable range\"}");
            return;
        }
        n = sprintf(reply, "{\"ok\":true,\"base\":\"0x%llX\",\"offset\":%d,\"count\":%d,\"qwords\":[",
                      (unsigned long long)(ULONG_PTR)g_host.rawHost, off, want);
        for (k = 0; k < want && n < CW_MAX_LINE - 200; k++) {
            ULONG_PTR v = *(ULONG_PTR *)((char *)g_host.rawHost + off + k * 8);
            char mname[64];
            mname[0] = 0;
            if (v) ModuleOf((void *)v, mname, sizeof(mname));
            /* Addresses go out as hex STRINGS, not JSON numbers.
             *
             * A 64-bit pointer exceeds JavaScript's safe integer range, so a
             * JSON number arrives at the client rounded: 0x1433505D8 came back
             * as ffffffff after precision loss, which reads as a corrupt value
             * rather than as a transport limit. A string is exact, and the
             * client parses it with BigInt when it needs to compute. */
            /* sprintf, not wsprintf: wsprintf is user32's reduced printf and
             * does NOT support the `ll` length modifier. Using it with %llX
             * corrupted the argument walk and killed the worker thread — every
             * later request timed out while SONAR itself stayed fine, which is
             * exactly the "bridge died, host alive" signature seen here. */
            n += sprintf(reply + n, "%s{\"i\":%d,\"v\":\"0x%llX\",\"module\":\"%s\"}",
                         k ? "," : "", k, (unsigned long long)v, mname);
        }
        sprintf(reply + n, "]}");
        SendLine(s, reply);
        return;
    }

    if (lstrcmpiA(op, "read") == 0) {
        /* Read N qwords at an absolute address. Pure reads.
         *
         * Needed because `dump` showed the host object holds THREE vtable
         * pointers — at +0x00, +0x18 and +0x20, all inside Sonar.exe. Those are
         * the multiple-inheritance sub-objects, and one of them is a much better
         * candidate for a usable interface than the main one (which is the
         * 13-slot IControlSurface). Following them is inspection, not
         * experimentation: nothing is called, so nothing can diverge. */
        ULONG_PTR addr = JsonU64(line, "addr", 0);
        int want = JsonInt(line, "count", 12);
        int k;
        if (want < 1) want = 1;
        if (want > 32) want = 32;
        if (!addr) { SendLine(s, "{\"ok\":false,\"error\":\"pass addr\"}"); return; }
        if (IsBadReadPtr((void *)addr, (size_t)(want * 8))) {
            sprintf(reply, "{\"ok\":false,\"error\":\"unreadable at 0x%llX\"}",
                      (unsigned long long)addr);
            SendLine(s, reply);
            return;
        }
        n = sprintf(reply, "{\"ok\":true,\"addr\":\"0x%llX\",\"qwords\":[", (unsigned long long)addr);
        for (k = 0; k < want && n < CW_MAX_LINE - 200; k++) {
            ULONG_PTR v = *(ULONG_PTR *)((char *)addr + k * 8);
            char mname[64];
            mname[0] = 0;
            if (v) ModuleOf((void *)v, mname, sizeof(mname));
            /* Addresses go out as hex STRINGS, not JSON numbers.
             *
             * A 64-bit pointer exceeds JavaScript's safe integer range, so a
             * JSON number arrives at the client rounded: 0x1433505D8 came back
             * as ffffffff after precision loss, which reads as a corrupt value
             * rather than as a transport limit. A string is exact, and the
             * client parses it with BigInt when it needs to compute. */
            /* sprintf, not wsprintf: wsprintf is user32's reduced printf and
             * does NOT support the `ll` length modifier. Using it with %llX
             * corrupted the argument walk and killed the worker thread — every
             * later request timed out while SONAR itself stayed fine, which is
             * exactly the "bridge died, host alive" signature seen here. */
            n += sprintf(reply + n, "%s{\"i\":%d,\"v\":\"0x%llX\",\"module\":\"%s\"}",
                         k ? "," : "", k, (unsigned long long)v, mname);
        }
        sprintf(reply + n, "]}");
        SendLine(s, reply);
        return;
    }

    if (lstrcmpiA(op, "qi") == 0) {
        /* QueryInterface an arbitrary object found by reading memory.
         *
         * This is the safe half of the interface hunt, and it is how the mixer
         * was finally identified. `dump` shows the host holds several COM
         * objects at fixed offsets; their RTTI names say one is CSonarMixer
         * (implementing ISonarMixer3/2/1), another CSonarCommands, another
         * CSonarMidiOut. What those objects DO per slot still needs their IIDs,
         * and the only reliable source is asking them.
         *
         * QueryInterface is a defined, non-destructive operation: it returns a
         * pointer or E_NOINTERFACE. Unlike calling an unknown vtable slot —
         * which crashed SONAR — it cannot run arbitrary code.
         *
         * The IID arrives as 32 hex digits in registry order (Data1, Data2,
         * Data3, then the last 8 bytes as written), because that is how a GUID
         * appears in documentation and how one gets copied in. */
        ULONG_PTR obj = JsonU64(line, "obj", 0);
        char iidStr[64];
        GUID iid;
        void *got = NULL;
        HRESULT qr;
        void **vt;
        typedef HRESULT (STDMETHODCALLTYPE *QIFn)(void *, const GUID *, void **);
        QIFn qi;

        if (!obj) { SendLine(s, "{\"ok\":false,\"error\":\"pass obj\"}"); return; }
        if (!JsonStr(line, "iid", iidStr, sizeof(iidStr))) {
            SendLine(s, "{\"ok\":false,\"error\":\"pass iid\"}");
            return;
        }
        if (ParseGuid(iidStr, &iid) != 0) {
            sprintf(reply, "{\"ok\":false,\"error\":\"cannot parse iid '%s'\"}", iidStr);
            SendLine(s, reply);
            return;
        }
        if (IsBadReadPtr((void *)obj, 8)) {
            SendLine(s, "{\"ok\":false,\"error\":\"object unreadable\"}");
            return;
        }
        /* Read the vtable first, so a null or non-code slot 0 is refused rather
         * than jumped to. */
        vt = *(void ***)obj;
        if (!vt || !vt[0] || !IsExecutable(vt[0])) {
            SendLine(s, "{\"ok\":false,\"error\":\"slot 0 is not executable\"}");
            return;
        }
        qi = (QIFn)vt[0];
        qr = qi((void *)obj, &iid, &got);
        {
            char vbuf[32] = "", ibuf[32] = "";
            if (got) {
                void **gvt = *(void ***)got;
                /* sprintf, never wsprintfA, for anything 64-bit. wsprintf is
                 * user32's reduced printf and has no `ll` modifier: it walks the
                 * argument list wrongly and faults inside USER32. That is not a
                 * theoretical risk — it is what crashed SONAR from this very
                 * line, with "Access Address 0000000000000001, faulting module
                 * USER32.dll, stack wvsprintfA <- wsprintfA". */
                sprintf(vbuf, "0x%llX", (unsigned long long)(ULONG_PTR)gvt);
                sprintf(ibuf, "0x%llX", (unsigned long long)(ULONG_PTR)got);
            }
            sprintf(reply,
                "{\"ok\":true,\"obj\":\"0x%llX\",\"hr\":\"0x%08X\",\"succeeded\":%s,"
                "\"iface\":\"%s\",\"ifaceVtable\":\"%s\"}",
                (unsigned long long)obj, (unsigned)qr,
                SUCCEEDED(qr) ? "true" : "false", ibuf, vbuf);
        }
        SendLine(s, reply);
        return;
    }

    if (lstrcmpiA(op, "call") == 0) {
        /* Call a vtable slot on an object reached by reading memory.
         *
         * READ THIS BEFORE USING IT FOR ANYTHING BUT DIAGNOSIS
         *
         * This primitive works — it resolved CSonarMixer at host+0x58, confirmed
         * its 18-slot vtable against a static extraction, and distinguished
         * argument positions by HRESULT. It was then used to try to identify
         * which slot is SetTargetParam, and that crashed SONAR twice:
         *
         *     Exception Code:    C0000005
         *     Exception Address: 0x141C573A6      (inside slot 6)
         *     Access Address:    0x0000000000000000
         *
         * Slot 6 turned out to be a getter whose a1/a2 are OUT POINTERS, so a
         * small integer there is a null dereference a few instructions in. Every
         * part of its disassembly that could be checked had been checked —
         * bounds, the E_NOTIMPL path, the parameter selector — and it still
         * faulted, because "three int arguments" was the wrong calling
         * convention and no amount of reading established the right one.
         *
         * The general rule, which cost five crashes to learn: an unknown C++
         * method cannot be identified by calling it. If a write path is needed,
         * find one that is already known to work. Here that was SONAR's own
         * track strips, which expose mute/solo/arm to accessibility and respond
         * to a real mouse click — see lib/track-ui.js and native/uia/.
         *
         * `call` is kept because it is the instrument that proved the mixer's
         * identity, and because a slot whose signature IS known (from the type
         * library, or from a call site read out of the binary) is a legitimate
         * thing to invoke. It is not kept as a way to discover signatures.
         *
         * Arguments are JSON integers only, so a caller cannot pass a pointer
         * deliberately; that is a guard against accidents, not a safety proof.
         * `obj` may be absolute or "host+N" for an object the host holds at a
         * fixed offset, which is how CSonarMixer is reached (host+0x58). */
        ULONG_PTR obj = 0;
        int slot = JsonInt(line, "slot", -1);
        int a1 = JsonInt(line, "a1", 0);
        int a2 = JsonInt(line, "a2", 0);
        int a3 = JsonInt(line, "a3", 0);
        int wantObj = JsonInt(line, "count", 18);
        char hostOff[64];
        void **vt;
        int slotsAvail = 0;

        obj = JsonU64(line, "obj", 0);
        /* "host+0x58" — resolve an object the host holds, without a second
         * round trip from the client. The offset is bounded and the read is
         * checked before it is dereferenced. */
        if (!obj && JsonStr(line, "hostOff", hostOff, sizeof(hostOff))) {
            char *endp = NULL;
            long off = strtol(hostOff, &endp, 0);
            if (off > 0 && off < 0x2000 && g_host.rawHost &&
                !IsBadReadPtr((char *)g_host.rawHost + off, sizeof(void *))) {
                obj = *(ULONG_PTR *)((char *)g_host.rawHost + off);
            }
            if (!obj) {
                sprintf(reply,
                    "{\"ok\":false,\"error\":\"hostOff '%s' holds no readable pointer\"}",
                    hostOff);
                SendLine(s, reply);
                return;
            }
        }
        if (!obj) { SendLine(s, "{\"ok\":false,\"error\":\"pass obj or hostOff\"}"); return; }
        if (slot < 0 || slot > 64) {
            SendLine(s, "{\"ok\":false,\"error\":\"slot out of range\"}");
            return;
        }
        if (IsBadReadPtr((void *)obj, 8)) {
            SendLine(s, "{\"ok\":false,\"error\":\"object unreadable\"}");
            return;
        }
        vt = *(void ***)obj;
        if (!vt || IsBadReadPtr(vt, sizeof(void *))) {
            SendLine(s, "{\"ok\":false,\"error\":\"vtable unreadable\"}");
            return;
        }
        /* The slot must be executable before it is jumped to. This is the one
         * check that turns "wild pointer" from a crash into an error string. */
        if (!IsExecutable(vt[slot])) {
            sprintf(reply,
                "{\"ok\":false,\"error\":\"slot %d is not executable\",\"target\":\"0x%llX\"}",
                slot, (unsigned long long)(ULONG_PTR)vt[slot]);
            SendLine(s, reply);
            return;
        }
        /* Which slots exist, answered by walking until the vtable leaves the
         * image. Reported so a caller can confirm it is talking to the object it
         * thinks it is: CSonarMixer has 18, and a different count means the
         * offset was wrong. */
        while (slotsAvail < wantObj && !IsBadReadPtr(&vt[slotsAvail], sizeof(void *)) &&
               IsExecutable(vt[slotsAvail])) {
            slotsAvail++;
        }

        Logf("call: obj=0x%llX slot=%d target=0x%llX slotsAvail=%d a=(%d,%d,%d) timeout=%lums",
             (unsigned long long)obj, slot, (unsigned long long)(ULONG_PTR)vt[slot],
             slotsAvail, a1, a2, a3, (unsigned long)kCallTimeoutMs);

        /* A single static job, not a stack local. A call that outlives its
         * timeout keeps running on its own thread, and that thread writes
         * `done` and `hr` when it finishes — into a frame that would already be
         * gone if this were a local. The call op is serialised by the worker
         * being single-threaded, so one static job cannot be entered twice. */
        g_job.fn = (Hresult4Fn)vt[slot];
        g_job.obj = (void *)obj;
        g_job.a1 = a1; g_job.a2 = a2; g_job.a3 = a3;
        g_job.hr = (HRESULT)0x8000FFFF;   /* E_UNEXPECTED until it completes */
        g_job.done = 0;
        RunCallWatched(&g_job, kCallTimeoutMs);

        sprintf(reply,
            "{\"ok\":true,\"obj\":\"0x%llX\",\"slot\":%d,\"target\":\"0x%llX\","
            "\"slotsAvail\":%d,\"a1\":%d,\"a2\":%d,\"a3\":%d,"
            "\"completed\":%s,\"hr\":\"0x%08X\"}",
            (unsigned long long)obj, slot, (unsigned long long)(ULONG_PTR)vt[slot],
            slotsAvail, a1, a2, a3,
            g_job.done ? "true" : "false", (unsigned)g_job.hr);
        SendLine(s, reply);
        return;
    }

    if (lstrcmpiA(op, "probe") == 0) {
        /* What the host object actually is. Served as its own op because it is
         * the one measurement that decides whether a write path is reachable
         * at all: without a matching interface there is no vtable slot to call,
         * and no amount of IDispatch will help. */
        n = sprintf(reply,
            "{\"ok\":true,\"host\":%lu,\"vtable\":%lu,\"hwndApp\":%lu,"
            "\"iids\":{",
            (unsigned long)(ULONG_PTR)g_host.rawHost,
            (unsigned long)(ULONG_PTR)g_host.vtable,
            (unsigned long)(ULONG_PTR)g_host.hwndApp);
        for (i = 0; g_probes[i].name; i++) {
            n += sprintf(reply + n, "%s\"%s\":%d", i ? "," : "",
                           g_probes[i].name, g_probes[i].ok);
        }
        n += sprintf(reply + n, "},\"vtableIn\":\"");
        JsonEscape(reply + n, CW_MAX_LINE - n - 64, g_identity.module);
        n += lstrlenA(reply + n);
        n += sprintf(reply + n, "\",\"class\":\"");
        JsonEscape(reply + n, CW_MAX_LINE - n - 64, g_rtti.found ? g_rtti.className : "");
        n += lstrlenA(reply + n);
        n += sprintf(reply + n, "\",\"rttiRaw\":\"");
        JsonEscape(reply + n, CW_MAX_LINE - n - 64, g_rtti.raw);
        n += lstrlenA(reply + n);
        n += sprintf(reply + n, "\",\"slots\":[");
        for (i = 0; i < 12 && n < CW_MAX_LINE - 400; i++) {
            /* The module is read from the cache filled during Connect. Calling
             * ModuleOf here re-enumerated every loaded module twelve times per
             * request, which made this reply slow enough to hit the client's
             * timeout — measured, and the reason `probe` appeared to hang.
             *
             * The length guard is the second fix: without it a long reply is
             * never terminated, and a truncated line looks identical to a dead
             * plugin from the client side. */
            char mname[64];
            mname[0] = 0;
            if (g_identity.slotModuleName[i][0]) {
                lstrcpynA(mname, g_identity.slotModuleName[i], sizeof(mname));
            }
            n += sprintf(reply + n, "%s{\"i\":%d,\"addr\":%lu,\"module\":\"%s\"}",
                           i ? "," : "", i,
                           (unsigned long)(ULONG_PTR)g_identity.slots[i], mname);
        }
        n += sprintf(reply + n, "],\"accepted\":[");
        /* The interfaces the host said yes to, with the vtable each one gave
         * back. This is the part that matters: these are usable.
         *
         * Only the vtable ADDRESS is sent, not every function pointer. The
         * first version listed all of them and the reply outgrew CW_MAX_LINE,
         * so the line was never terminated and the client timed out — a
         * response that is too long looks exactly like a hang. The slot
         * addresses are recoverable from the vtable address offline, which is
         * how they were analysed anyway. */
        for (i = 0; i < g_acceptedCount; i++) {
            n += sprintf(reply + n, "%s{\"iface\":%lu,\"vtable\":%lu,\"slots\":%d}",
                           i ? "," : "",
                           (unsigned long)(ULONG_PTR)g_accepted[i].iface,
                           (unsigned long)(ULONG_PTR)g_accepted[i].vtable,
                           g_accepted[i].slots);
        }
        sprintf(reply + n, "]}");
        SendLine(s, reply);
        return;
    }

    if (lstrcmpiA(op, "diag") == 0) {
        char escErr[512];
        JsonEscape(escErr, sizeof(escErr), g_host.lastError);
        n = sprintf(reply,
            "{\"ok\":true,\"connected\":%d,"
            "\"qi\":{\"dispatch\":%d,\"unknown\":%d,\"surface\":%d,\"surface2\":%d,\"surface3\":%d},"
            "\"refresh\":{\"count\":%d,\"firstTick\":%lu,\"lastTick\":%lu},"
            "\"sets\":{\"ok\":%d,\"failed\":%d,\"lastBaseTrack\":%d},"
            "\"lastError\":\"%s\",\"log\":[",
            g_host.connected,
            g_host.qiDispatch, g_host.qiUnknown, g_host.qiSurface,
            g_host.qiSurface2, g_host.qiSurface3,
            g_host.refreshCount,
            (unsigned long)g_host.firstRefreshTick, (unsigned long)g_host.lastRefreshTick,
            g_host.setCalls, g_host.setFailures, g_host.baseTrack,
            escErr);
        if (g_csReady) EnterCriticalSection(&g_cs);
        for (i = 0; i < g_logCount && n < CW_MAX_LINE - 400; i++) {
            char escLog[512];
            JsonEscape(escLog, sizeof(escLog), g_log[i]);
            n += sprintf(reply + n, "%s\"%s\"", i ? "," : "", escLog);
        }
        if (g_csReady) LeaveCriticalSection(&g_cs);
        sprintf(reply + n, "]}");
        SendLine(s, reply);
        return;
    }

    if (lstrcmpiA(op, "params") == 0) {
        n = sprintf(reply, "{\"ok\":true,\"params\":[");
        for (i = 0; g_params[i].name; i++) {
            n += sprintf(reply + n, "%s{\"name\":\"%s\",\"value\":%d}",
                           i ? "," : "", g_params[i].name, g_params[i].value);
        }
        sprintf(reply + n, "]}");
        SendLine(s, reply);
        return;
    }

    if (lstrcmpiA(op, "set") == 0) {
        if (!JsonStr(line, "param", paramName, sizeof(paramName))) {
            SendLine(s, "{\"ok\":false,\"error\":\"missing param\"}");
            return;
        }
        pd = FindParam(paramName);
        if (!pd) {
            sprintf(reply, "{\"ok\":false,\"error\":\"unknown param '%s'\"}", paramName);
            SendLine(s, reply);
            return;
        }
        track = JsonInt(line, "track", 1);
        value = JsonInt(line, "value", 0);
        if (!g_host.connected) {
            SendLine(s, "{\"ok\":false,\"error\":\"not connected: SONAR has not called Connect\"}");
            return;
        }
        if (SetOneParam(track, pd->value, (DWORD)value)) {
            sprintf(reply, "{\"ok\":true,\"param\":\"%s\",\"track\":%d,\"value\":%d}",
                      pd->name, track, value);
        } else {
            char escErr[512];
            JsonEscape(escErr, sizeof(escErr), g_host.lastError);
            sprintf(reply,
                "{\"ok\":false,\"param\":\"%s\",\"track\":%d,\"error\":\"%s\"}",
                pd->name, track, escErr);
        }
        SendLine(s, reply);
        return;
    }

    sprintf(reply, "{\"ok\":false,\"error\":\"unknown op '%s'\"}", op);
    SendLine(s, reply);
}

static DWORD WINAPI WorkerProc(LPVOID arg)
{
    WSADATA wsa;
    struct sockaddr_in addr;
    int opt = 1;
    (void)arg;

    /* Surface auth must be established before we touch the network. If the
     * parent did not hand us a well-formed token we fail closed. The log line
     * deliberately contains no part of the token. */
    if (!SurfaceAuthInit()) {
        Logf("worker: surface auth init failed (missing/invalid CW_SURFACE_TOKEN)");
        return 1;
    }

    Logf("worker: starting on 127.0.0.1:%d", g_port);
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        Logf("worker: WSAStartup failed");
        return 1;
    }

    g_listen = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (g_listen == INVALID_SOCKET) { Logf("worker: socket() failed"); return 1; }

    setsockopt(g_listen, SOL_SOCKET, SO_REUSEADDR, (const char *)&opt, sizeof(opt));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   /* loopback only — never exposed */
    addr.sin_port = htons((u_short)g_port);

    /* Bind with retries, because a single failure used to kill the worker for
     * the life of the process.
     *
     * The original code logged "bind failed" and returned, so one transient
     * conflict — a previous SONAR's socket still in TIME_WAIT, or a leftover
     * client holding the port — left the plugin loaded but permanently
     * unreachable, with the only clue in OutputDebugString where nothing could
     * read it. The symptom was maddening: the DLL showed in the process's
     * module list, netstat showed the port LISTENING (from the stale entry), and
     * every connection was refused.
     *
     * SO_REUSEADDR is set above, which covers TIME_WAIT on the listening side;
     * the retry covers the rest. After the attempts are exhausted the worker
     * says so in the log file and gives up, which is the honest outcome. */
    {
        int attempt;
        int bound = 0;
        for (attempt = 0; attempt < 20 && !g_stopWorker; attempt++) {
            if (bind(g_listen, (struct sockaddr *)&addr, sizeof(addr)) == 0) { bound = 1; break; }
            {
                int err = WSAGetLastError();
                Logf("worker: bind attempt %d failed err=%d", attempt + 1, err);
                /* 10048 = WSAEADDRINUSE. Only that one is worth waiting out;
                 * anything else will not improve. */
                if (err != 10048) break;
            }
            Sleep(500);
        }
        if (!bound) {
            Logf("worker: giving up on port %d after retries", g_port);
            closesocket(g_listen); g_listen = INVALID_SOCKET;
            return 1;
        }
    }
    if (listen(g_listen, 4) != 0) { Logf("worker: listen failed err=%d", WSAGetLastError()); return 1; }
    Logf("worker: listening on %d", g_port);

    while (!g_stopWorker) {
        SOCKET c;
        struct sockaddr_in peer;
        int plen = sizeof(peer);
        /* A one-second accept timeout via select, so the stop flag is honoured
         * without needing a self-connect to wake the loop. */
        fd_set rd;
        struct timeval tv;
        FD_ZERO(&rd);
        FD_SET(g_listen, &rd);
        tv.tv_sec = 1; tv.tv_usec = 0;
        if (select(0, &rd, NULL, NULL, &tv) <= 0) continue;

        c = accept(g_listen, (struct sockaddr *)&peer, &plen);
        if (c == INVALID_SOCKET) continue;

        /* Bound blocking on a hostile client: 2s of silence ends recv/send. */
        {
            DWORD tmo = 2000;
            setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tmo, sizeof(tmo));
            setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, (const char *)&tmo, sizeof(tmo));
        }
        Logf("worker: client connected");

        /* Serve one client until it goes away. The Node side keeps a single
         * long-lived connection, matching the project's other bridges. */
        for (;;) {
            char buf[CW_MAX_LINE];
            int used = 0, done = 0;
            /* A partial frame (bytes without a terminating newline) must not be
             * allowed to sit forever: 5000 ms total, measured from the first
             * byte of the incomplete frame, checked before each recv. */
            ULONGLONG frameStart = 0;

            if (g_stopWorker) break;

            while (!done && used < CW_MAX_LINE - 1) {
                int r;
                int i;

                if (g_stopWorker) { done = 2; break; }

                if (used > 0 && frameStart != 0) {
                    if (GetTickCount64() - frameStart > 5000) { done = 2; break; }
                }

                r = recv(c, buf + used, CW_MAX_LINE - 1 - used, 0);
                if (r <= 0) { done = 2; break; }
                used += r;
                buf[used] = 0;
                for (i = 0; i < used; i++) {
                    if (buf[i] == '\n') {
                        char line[CW_MAX_LINE];
                        int len = i;
                        if (len >= CW_MAX_LINE) len = CW_MAX_LINE - 1;
                        memcpy(line, buf, len); line[len] = 0;
                        memmove(buf, buf + i + 1, used - i - 1);
                        used -= (i + 1);
                        buf[used] = 0;
                        frameStart = (used > 0) ? GetTickCount64() : 0; /* frame complete: reset */
                        HandleLine(c, line);
                        i = -1;   /* rescan from the new start */
                    }
                }
                if (used > 0 && frameStart == 0) frameStart = GetTickCount64();
            }

            if (done == 2) break;

            /* Line buffer filled with no newline: an overlong, non-terminated
             * frame. Drop the connection without a reset and let the outer loop
             * accept the next client. */
            if (used >= CW_MAX_LINE - 1) {
                int nl = 0;
                int k;
                for (k = 0; k < used; k++) { if (buf[k] == '\n') { nl = 1; break; } }
                if (!nl) { done = 3; break; }
            }
        }
        closesocket(c);
        Logf("worker: client disconnected");
    }

    closesocket(g_listen);
    g_listen = INVALID_SOCKET;
    WSACleanup();
    Logf("worker: stopped");
    return 0;
}

static void StartWorker(void)
{
    DWORD tid;
    if (g_workerThread) return;
    g_stopWorker = 0;
    g_workerThread = CreateThread(NULL, 0, WorkerProc, NULL, 0, &tid);
    if (!g_workerThread) Logf("CreateThread failed err=%lu", GetLastError());
}

static void StopWorker(void)
{
    if (!g_workerThread) return;
    InterlockedExchange(&g_stopWorker, 1);
    WaitForSingleObject(g_workerThread, 3000);
    CloseHandle(g_workerThread);
    g_workerThread = NULL;
}

/* ------------------------------------------------------- class factory ----- */

static HRESULT STDMETHODCALLTYPE CF_QI(IClassFactory *s, REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IClassFactory)) {
        *ppv = s; return S_OK;
    }
    *ppv = NULL; return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE CF_AddRef(IClassFactory *s) { (void)s; return 2; }
static ULONG STDMETHODCALLTYPE CF_Release(IClassFactory *s) { (void)s; return 1; }
static HRESULT STDMETHODCALLTYPE CF_CreateInstance(IClassFactory *s, IUnknown *outer,
                                                   REFIID riid, void **ppv)
{
    (void)s; (void)outer;
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (!IsEqualIID(riid, &IID_IUnknown) && !IsEqualIID(riid, &IID_IDispatch) &&
        !IsEqualIID(riid, &IID_IControlSurface_p) &&
        !IsEqualIID(riid, &IID_IControlSurface2_p) &&
        !IsEqualIID(riid, &IID_IControlSurface3_p))
        return E_NOINTERFACE;
    *ppv = (void *)g_objVtbl;   /* the object itself, not &something-that-points */
    InterlockedIncrement(&g_refCount);
    return S_OK;
}
static HRESULT STDMETHODCALLTYPE CF_LockServer(IClassFactory *s, BOOL f)
{
    (void)s;
    if (f) InterlockedIncrement(&g_lockCount); else InterlockedDecrement(&g_lockCount);
    return S_OK;
}

static const IClassFactoryVtbl g_cfVtbl = {
    CF_QI, CF_AddRef, CF_Release, CF_CreateInstance, CF_LockServer
};
static IClassFactory g_cf = { &g_cfVtbl };

/* ------------------------------------------------------------- exports ----- */

__declspec(dllexport) HRESULT STDMETHODCALLTYPE DllCanUnloadNow(void)
{
    return (g_refCount == 0 && g_lockCount == 0) ? S_OK : S_FALSE;
}

__declspec(dllexport) HRESULT STDMETHODCALLTYPE DllGetClassObject(REFCLSID rclsid,
                                                                  REFIID riid, void **ppv)
{
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (!IsEqualCLSID(rclsid, &CLSID_CwSurface)) return CLASS_E_CLASSNOTAVAILABLE;
    return CF_QI(&g_cf, riid, ppv);
}

/* Self-registration. TWO key trees, both required — established the hard way,
 * after a wrong path cost a full rebuild-and-reload cycle:
 *
 * 1. HKCR\CLSID\{CLSID}\InprocServer32  = the DLL path      (the COM server)
 * 2. HKCR\CakewalkControlSurfaces\{CLSID}
 *        Description  = the name shown in the picker
 *        HelpFilePath = per-surface help, may be empty
 *
 * Key 2 is the DISCOVERY key and the one that actually puts the plugin in the
 * 控制界面 list. Its absence was invisible at first, because every interface
 * probe still passed: the DLL loaded, QueryInterface answered, the bridge
 * listened on its port — but Preferences > MIDI > Control Surfaces stayed at
 * five entries, since nothing had told SONAR this surface existed.
 *
 * The shipped entries, read verbatim from HKCR:
 *   {0A7F7099-...}  Description = "ACT MIDI Controller"
 *   {404C9315-...}  Description = "Cakewalk Generic Surface"
 *   {73AD3A4D-...}  Description = "Mackie Control C4"
 *   {DE11FD90-...}  Description = "Mackie Control XT"
 *   {F5CC6567-...}  Description = "Mackie Control"
 * — five GUIDs, two values each, no allowlist. A sixth entry is all it takes.
 *
 * Note the path: HKCR\CakewalkControlSurfaces, NOT
 * HKLM\SOFTWARE\Classes\CakewalkControlSurfaces. The latter is where this first
 * looked, and it is empty. Writing through HKCR from a non-elevated process
 * lands in HKCU\SOFTWARE\Classes, which is part of the merged HKCR view SONAR
 * reads, so this still needs no elevation.
 *
 * This touches only COM and surface registration. It does not go near
 * licensing. */
static const char *REG_CLSID_PATH =
    "SOFTWARE\\Classes\\CLSID\\{7C4A9B21-3D5E-4F8A-9E21-6B4D380A7C51}";
static const char *REG_SURFACE_PATH =
    "SOFTWARE\\Classes\\CakewalkControlSurfaces\\{7C4A9B21-3D5E-4F8A-9E21-6B4D380A7C51}";

static int RegSetString(HKEY root, const char *subkey, const char *value, const char *data)
{
    HKEY k;
    LONG r = RegCreateKeyExA(root, subkey, 0, NULL, 0, KEY_WRITE, NULL, &k, NULL);
    if (r != ERROR_SUCCESS) {
        Logf("RegCreateKeyEx(%s) failed err=%ld", subkey, r);
        return 0;
    }
    r = RegSetValueExA(k, value, 0, REG_SZ, (const BYTE *)data, (DWORD)lstrlenA(data) + 1);
    RegCloseKey(k);
    if (r != ERROR_SUCCESS) { Logf("RegSetValueEx(%s) failed err=%ld", value, r); return 0; }
    return 1;
}

/* SELFREG_E_CLASS is the standard "registration failed" code; it lives in the
 * MSVC-only comdef.h, so spell it out. */
#ifndef SELFREG_E_CLASS
#define SELFREG_E_CLASS ((HRESULT)0x800401F3L)
#endif

static int RegDropTree(HKEY root, const char *subkey)
{
    LSTATUS r = RegDeleteTreeA(root, subkey);
    return (r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND);
}

__declspec(dllexport) HRESULT STDMETHODCALLTYPE DllRegisterServer(void)
{
    char dllPath[MAX_PATH];
    char progId[128];
    char inproc[256];
    int ok = 1;

    if (!GetModuleFileNameA(g_hInst, dllPath, MAX_PATH)) {
        Logf("DllRegisterServer: GetModuleFileName failed");
        return SELFREG_E_CLASS;
    }

    Logf("DllRegisterServer: %s", dllPath);

    wsprintfA(progId, "CwSurface.ControlSurface.1");
    wsprintfA(inproc, "%s\\InProcServer32", REG_CLSID_PATH);

    /* The class object itself, then InprocServer32 with the threading model.
     * "both" matches the shipped surfaces. */
    ok &= RegSetString(HKEY_CURRENT_USER, REG_CLSID_PATH, NULL, "Cakewalk MCP Surface Bridge");

    {
        HKEY k;
        char key[256];
        wsprintfA(key, "%s\\ProgID", REG_CLSID_PATH);
        ok &= RegSetString(HKEY_CURRENT_USER, key, NULL, progId);
        wsprintfA(key, "%s\\VersionIndependentProgID", REG_CLSID_PATH);
        ok &= RegSetString(HKEY_CURRENT_USER, key, NULL, "CwSurface.ControlSurface");
    }

    ok &= RegSetString(HKEY_CURRENT_USER, inproc, NULL, dllPath);
    ok &= RegSetString(HKEY_CURRENT_USER, inproc, "ThreadingModel", "both");

    /* The discovery entry. Without this the DLL loads but never appears in the
     * picker — see the comment on REG_SURFACE_PATH. */
    ok &= RegSetString(HKEY_CURRENT_USER, REG_SURFACE_PATH, "Description",
                       "Cakewalk MCP Surface Bridge");
    ok &= RegSetString(HKEY_CURRENT_USER, REG_SURFACE_PATH, "HelpFilePath", "");

    if (!ok) {
        Logf("DllRegisterServer: FAILED");
        return SELFREG_E_CLASS;
    }
    Logf("DllRegisterServer: ok (HKCU, no elevation)");
    return S_OK;
}

__declspec(dllexport) HRESULT STDMETHODCALLTYPE DllUnregisterServer(void)
{
    Logf("DllUnregisterServer");
    RegDropTree(HKEY_CURRENT_USER, REG_CLSID_PATH);
    RegDropTree(HKEY_CURRENT_USER, REG_SURFACE_PATH);
    RegDeleteTree(HKEY_CURRENT_USER, "SOFTWARE\\Classes\\CwSurface.ControlSurface");
    RegDeleteTree(HKEY_CURRENT_USER, "SOFTWARE\\Classes\\CwSurface.ControlSurface.1");
    return S_OK;
}

/* Should this process be running the bridge worker?
 *
 * NO for regsvr32 and rundll32. Both load the DLL only to call
 * DllRegisterServer / DllUnregisterServer, and both then tear the process down
 * immediately. Starting a socket worker there produced a hard crash at unload —
 * regsvr32 died with a segfault even though the registry writes had already
 * succeeded, which reads as "registration failed" when it did not.
 *
 * The host that matters is SONAR. Rather than allowlisting it, exclude the two
 * tools that are known to load us for registration only: that way a future
 * non-SONAR host still gets a working bridge, and the two known-bad ones do not
 * drag a live worker through process teardown. */
static int ShouldStartWorker(void)
{
    char exe[MAX_PATH];
    const char *base;
    DWORD n = GetModuleFileNameA(NULL, exe, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return 0;
    base = exe;
    {
        const char *p = exe;
        while (*p) { if (*p == '\\' || *p == '/') base = p + 1; p++; }
    }
    if (lstrcmpiA(base, "regsvr32.exe") == 0) return 0;
    if (lstrcmpiA(base, "rundll32.exe") == 0) return 0;
    if (lstrcmpiA(base, "dllhost.exe") == 0) return 0;
    return 1;
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r)
{
    (void)r;
    if (reason == DLL_PROCESS_ATTACH) {
        g_hInst = h;
        DisableThreadLibraryCalls(h);
        InitializeCriticalSection(&g_cs);
        g_csReady = 1;
        InitVtbl();
        /* Optional port override for a second instance during testing. */
        {
            char env[32];
            DWORD n = GetEnvironmentVariableA("CW_SURFACE_PORT", env, sizeof(env));
            if (n > 0 && n < sizeof(env)) {
                int p = atoi(env);
                if (p > 1024 && p < 65536) g_port = p;
            }
        }
        Logf("DllMain: attached, pid=%lu port=%d", GetCurrentProcessId(), g_port);
        /* The worker is skipped under regsvr32 — see ShouldStartWorker. The
         * COM object still works there, which is all registration needs. */
        if (ShouldStartWorker()) {
            StartWorker();
        } else {
            Logf("DllMain: not starting worker (registration-only host)");
        }
    } else if (reason == DLL_PROCESS_DETACH) {
        Logf("DllMain: detaching");
        if (g_workerThread) StopWorker();
        if (g_host.host) { IDispatch_Release(g_host.host); g_host.host = NULL; }
        if (g_csReady) { g_csReady = 0; DeleteCriticalSection(&g_cs); }
    }
    return TRUE;
}
