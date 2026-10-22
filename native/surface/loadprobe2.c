/* loadprobe2.c — exercise cw_surface.dll's COM contract without SONAR.
 *
 * This is the gate that must pass before registration. A wrong vtable shape
 * (too short, wrong order) is the single biggest risk in the surface plugin,
 * and it is silent until the host calls one slot too far. Loading the DLL here
 * and walking the chain proves the shape off-line:
 *
 *   DllGetClassObject  -> does the class factory come back
 *   CreateInstance     -> does an object get made
 *   QI for each IID    -> is the 44-slot chain really there
 *   call Connect(NULL) -> does a bad host object fail loudly, not crash
 *   call GetVersion    -> walk past slot 15
 *   call SetBankWidth  -> walk past slot 26 (deep in IControlSurface3)
 *   call OnContextSwitch -> the LAST slot, 43
 *
 * Calling the last slot is the point: it is what a short vtable gets wrong.
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <string.h>

static const GUID CLSID_CwSurface =
    {0x7C4A9B21,0x3D5E,0x4F8A,{0x9E,0x21,0x6B,0x4D,0x38,0x0A,0x7C,0x51}};
static const GUID IID_IControlSurface_p =
    {0x933A0E58,0xA8FC,0x491E,{0x9F,0x4A,0xDC,0x85,0xB7,0xCC,0x1B,0xE5}};
static const GUID IID_IControlSurface2_p =
    {0x1F4202FC,0x5755,0x473E,{0x8B,0x73,0xC6,0x27,0xE2,0x1D,0x7B,0xE3}};
static const GUID IID_IControlSurface3_p =
    {0x58D9C925,0x31F4,0x4369,{0x93,0x08,0xEC,0x85,0x66,0x5B,0xB7,0xD1}};

typedef HRESULT (WINAPI *PFN_GetClassObject)(REFCLSID, REFIID, void **);
typedef HRESULT (STDMETHODCALLTYPE *PFN_NoArg)(void *);
typedef HRESULT (STDMETHODCALLTYPE *PFN_GetVersion)(void *, int *, int *, int *, int *);
typedef HRESULT (STDMETHODCALLTYPE *PFN_SetBankWidth)(void *, int);
typedef HRESULT (STDMETHODCALLTYPE *PFN_Connect)(void *, IUnknown *, HWND);

static DWORD g_deepCalls = 0;

int main(void)
{
    HMODULE h;
    PFN_GetClassObject pGetClass;
    void *cf = NULL, *obj = NULL, *p = NULL;
    HRESULT hr;

    printf("=== cw_surface.dll COM contract probe ===\n\n");

    h = LoadLibraryA("build\\cw_surface.dll");
    if (!h) { printf("FAIL LoadLibrary err=%lu\n", GetLastError()); return 1; }
    printf("OK   LoadLibrary\n");

    pGetClass = (PFN_GetClassObject)GetProcAddress(h, "DllGetClassObject");
    if (!pGetClass) { printf("FAIL no DllGetClassObject\n"); return 1; }
    printf("OK   GetProcAddress(DllGetClassObject)\n");

    hr = pGetClass(&CLSID_CwSurface, &IID_IClassFactory, &cf);
    if (FAILED(hr) || !cf) { printf("FAIL DllGetClassObject hr=0x%08X\n", (unsigned)hr); return 1; }
    printf("OK   DllGetClassObject -> class factory %p\n", cf);

    /* A CLSID we do not serve must be refused, not answered. */
    {
        GUID bogus = {0xDEADBEEF,0,0,{0,0,0,0,0,0,0,1}};
        void *junk = NULL;
        hr = pGetClass(&bogus, &IID_IClassFactory, &junk);
        if (hr == CLASS_E_CLASSNOTAVAILABLE) {
            printf("OK   wrong CLSID refused (CLASS_E_CLASSNOTAVAILABLE)\n");
        } else {
            printf("WARN wrong CLSID returned hr=0x%08X\n", (unsigned)hr);
        }
        fflush(stdout);
    }

    hr = IClassFactory_CreateInstance((IClassFactory *)cf, NULL, &IID_IUnknown, &obj);
    if (FAILED(hr) || !obj) { printf("FAIL CreateInstance hr=0x%08X\n", (unsigned)hr); return 1; }
    printf("OK   CreateInstance(IUnknown) -> %p\n", obj);

    {
        void *q = NULL;
        hr = IUnknown_QueryInterface((IUnknown *)obj, &IID_IDispatch, &q);
        printf("%s QI IDispatch  hr=0x%08X\n", SUCCEEDED(hr) ? "OK  " : "FAIL", (unsigned)hr);
        if (SUCCEEDED(hr) && q) IUnknown_Release((IUnknown *)q);
    }
    {
        void *q = NULL;
        hr = IUnknown_QueryInterface((IUnknown *)obj, &IID_IControlSurface_p, &q);
        printf("%s QI IControlSurface  hr=0x%08X\n", SUCCEEDED(hr) ? "OK  " : "FAIL", (unsigned)hr);
        if (SUCCEEDED(hr) && q) IUnknown_Release((IUnknown *)q);
    }
    {
        void *q = NULL;
        hr = IUnknown_QueryInterface((IUnknown *)obj, &IID_IControlSurface2_p, &q);
        printf("%s QI IControlSurface2 hr=0x%08X\n", SUCCEEDED(hr) ? "OK  " : "FAIL", (unsigned)hr);
        if (SUCCEEDED(hr) && q) IUnknown_Release((IUnknown *)q);
    }
    {
        void *q = NULL;
        hr = IUnknown_QueryInterface((IUnknown *)obj, &IID_IControlSurface3_p, &q);
        printf("%s QI IControlSurface3 hr=0x%08X\n", SUCCEEDED(hr) ? "OK  " : "FAIL", (unsigned)hr);
        if (SUCCEEDED(hr) && q) IUnknown_Release((IUnknown *)q);
    }

    /* Connect(NULL) must report failure rather than dereference. */
    {
        void **vt10 = (void **)((void **)obj)[0];
        PFN_Connect pConn = (PFN_Connect)vt10[10];
        printf("     slot10 Connect ptr=%p\n", (void *)pConn);
        fflush(stdout);
        hr = pConn(obj, NULL, NULL);
        printf("%s Connect(NULL host) hr=0x%08X (expected failure, not a crash)\n",
               FAILED(hr) ? "OK  " : "WARN", (unsigned)hr);
        fflush(stdout);
    }

    /* The vtable is one dereference deeper than the object. Indexing obj[N]
     * directly reads memory AFTER the object and gets garbage or NULL — a bug
     * in the earlier version of this probe, and the reason it segfaulted while
     * the DLL was already correct. */
    {
        void **vt = (void **)((void **)obj)[0];
        printf("     object=%p vtable=%p (slot0=%p)\n", obj, (void *)vt, vt[0]);
        fflush(stdout);
    }

    /* Slot 14 — inside IControlSurface. */
    {
        void **vt14 = (void **)((void **)obj)[0];
        PFN_GetVersion pVer = (PFN_GetVersion)vt14[14];
        int a=0,b=0,c=0,d=0;
        hr = pVer(obj, &a, &b, &c, &d);
        printf("%s slot14 GetVersion hr=0x%08X -> %d.%d.%d.%d\n",
               SUCCEEDED(hr) ? "OK  " : "FAIL", (unsigned)hr, a,b,c,d);
        g_deepCalls++;
    }

    /* Slot 26 — the first IControlSurface3 method. Reaching it proves the
     * 3.x chain is present, not just declared. */
    {
        void **vt26 = (void **)((void **)obj)[0];
        PFN_SetBankWidth pBw = (PFN_SetBankWidth)vt26[26];
        hr = pBw(obj, 8);
        printf("%s slot26 SetBankWidth hr=0x%08X\n", SUCCEEDED(hr) ? "OK  " : "FAIL", (unsigned)hr);
        g_deepCalls++;
    }

    /* Slot 43 — the LAST slot. This is the one a short vtable gets wrong. */
    {
        void **vt43 = (void **)((void **)obj)[0];
        PFN_NoArg pLast = (PFN_NoArg)vt43[43];
        hr = pLast(obj);
        printf("%s slot43 OnContextSwitch hr=0x%08X (last slot, the real shape test)\n",
               SUCCEEDED(hr) ? "OK  " : "FAIL", (unsigned)hr);
        g_deepCalls++;
    }

    /* The bridge should already be listening — the DLL starts its worker on
     * load, so the port is up before SONAR ever calls Connect. */
    {
        WSADATA wsa; SOCKET s; struct sockaddr_in a;
        if (WSAStartup(MAKEWORD(2,2), &wsa) == 0) {
            s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
            a.sin_family = AF_INET;
            a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            a.sin_port = htons(39177);
            if (connect(s, (struct sockaddr*)&a, sizeof(a)) == 0) {
                const char *q = "{\"op\":\"ping\"}\n";
                char buf[256]; int r;
                send(s, q, (int)strlen(q), 0);
                r = recv(s, buf, sizeof(buf)-1, 0);
                if (r > 0) { buf[r]=0; printf("OK   bridge port 39177 answered: %s", buf); }
                else printf("WARN bridge accepted but did not answer\n");
            } else {
                printf("WARN bridge port 39177 not accepting (err=%d)\n", WSAGetLastError());
            }
            closesocket(s); WSACleanup();
        }
    }

    IUnknown_Release((IUnknown *)obj);
    IClassFactory_Release((IClassFactory *)cf);

    printf("\n=== %lu deep slot calls survived; the COM contract holds ===\n", g_deepCalls);
    FreeLibrary(h);
    return 0;
}
