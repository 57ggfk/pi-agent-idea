"""Read JCEF API signatures straight from IDEA's installed jars (no javap needed).

Parses .class constant pools to answer "does this API exist in THIS IDE build" —
exactly the 042/043 pre-plan probe: JBCefHealthMonitor.TOPIC name, certificate /
download / popup callbacks, request-context isolation, rendering mode knobs.

Usage: python scripts/probe-042-api.py
"""
import glob
import json
import os
import struct
import zipfile

IDEA = os.path.expandvars(r"%LOCALAPPDATA%\Programs\IntelliJ IDEA")
JLIB = os.path.join(IDEA, "plugins", "jcef-plugin", "lib")

# class suffix -> list of method names we care about (empty = dump all methods)
WANT = {
    "com/intellij/ui/jcef/JBCefHealthMonitor$JBCefHealthCheckTopic": [],
    "com/intellij/ui/jcef/JBCefHealthMonitor": [],
    "com/intellij/ui/jcef/JBCefBrowserBuilder": [],
    "com/intellij/ui/jcef/JBCefBrowser": ["loadURL", "getCefBrowser", "getComponent", "setDisplayHandler"],
    "org/cef/handler/CefRequestHandler": ["onCertificateError", "getAuthCredentials", "onBeforeBrowse", "onBeforeResourceLoad"],
    "org/cef/handler/CefRequestHandlerAdapter": ["onCertificateError", "getAuthCredentials"],
    "org/cef/handler/CefDownloadHandler": ["onBeforeDownload", "onDownloadUpdated"],
    "org/cef/handler/CefLifeSpanHandler": ["onBeforePopup"],
    "org/cef/handler/CefDisplayHandler": ["onTitleChange", "onAddressChange", "onTooltip", "onConsoleMessage"],
    "org/cef/handler/CefLoadHandler": ["onLoadEnd", "onLoadError", "onLoadingStateChange"],
    "org/cef/browser/CefRequestContext": ["createContext", "isSame", "getCachePath", "registerSchemeHandlerFactory"],
    "org/cef/browser/CefBrowser": ["getHost", "getMainFrame", "loadURL"],
    "com/intellij/ui/jcef/JBCefClient$Properties": [],
}


def u2(b, i):
    return struct.unpack_from(">H", b, i)[0]


def u4(b, i):
    return struct.unpack_from(">I", b, i)[0]


def parse_class(data):
    """Return (class_name, [field names], [method names], [utf8 strings])."""
    i = 8  # magic(4) + minor(2) + major(2)
    cp_count = u2(data, i); i += 2
    cp = [None] * cp_count
    utf8s = []
    j = 1
    while j < cp_count:
        tag = data[i]; i += 1
        if tag == 1:  # CONSTANT_Utf8
            ln = u2(data, i); i += 2
            s = data[i:i + ln].decode("utf-8", "replace"); i += ln
            cp[j] = ("utf8", s); utf8s.append(s)
        elif tag == 3:  # Integer
            i += 4; cp[j] = ("int",)
        elif tag == 4:  # Float
            i += 4; cp[j] = ("float",)
        elif tag == 5:  # Long (2 slots)
            i += 8; cp[j] = ("long",); j += 1
        elif tag == 6:  # Double (2 slots)
            i += 8; cp[j] = ("double",); j += 1
        elif tag == 7:  # Class
            cp[j] = ("class", u2(data, i)); i += 2
        elif tag == 8:  # String
            cp[j] = ("string", u2(data, i)); i += 2
        elif tag in (9, 10, 11):  # Fieldref / Methodref / InterfaceMethodref
            cp[j] = ("ref", u2(data, i), u2(data, i + 2)); i += 4
        elif tag == 12:  # NameAndType
            cp[j] = ("nat", u2(data, i), u2(data, i + 2)); i += 4
        elif tag == 15:  # MethodHandle
            i += 3; cp[j] = ("mh",)
        elif tag == 16:  # MethodType
            i += 2; cp[j] = ("mt",)
        elif tag == 18:  # InvokeDynamic
            i += 4; cp[j] = ("ind",)
        elif tag == 19:  # Module
            i += 2; cp[j] = ("module",)
        elif tag == 20:  # Package
            i += 2; cp[j] = ("package",)
        else:
            raise ValueError(f"unknown cp tag {tag} at {i}")
        j += 1

    def utf(idx):
        e = cp[idx]
        return e[1] if e and e[0] == "utf8" else f"#{idx}"

    # skip access(2), this_class(2), super(2)
    i += 6
    iface_count = u2(data, i); i += 2 + iface_count * 2

    def skip_attrs(p):
        n = u2(data, p); p += 2
        for _ in range(n):
            p += 2
            ln = u4(data, p); p += 4 + ln
        return p

    # fields
    fc = u2(data, i); i += 2
    fields = []
    for _ in range(fc):
        i += 2  # access
        name = utf(u2(data, i)); i += 2
        i += 2  # descriptor
        i = skip_attrs(i)
        fields.append(name)

    # methods
    mc = u2(data, i); i += 2
    methods = []
    for _ in range(mc):
        i += 2  # access
        name = utf(u2(data, i)); i += 2
        desc = utf(u2(data, i)); i += 2
        i = skip_attrs(i)
        methods.append((name, desc))

    # this class name
    this_idx = u2(data, 8 + 2 + 2 + 6 - 6 + 0) if False else None
    # recover this_class from header: magic+minor+major+cp_count+cp bytes is complex;
    # instead take it from the first CONSTANT_Class that matches our target via caller.
    return fields, methods, utf8s


def main():
    jars = glob.glob(os.path.join(JLIB, "**", "*.jar"), recursive=True)
    found = {}
    for jp in jars:
        try:
            z = zipfile.ZipFile(jp)
        except zipfile.BadZipFile:
            continue
        for cls in WANT:
            entry = cls + ".class"
            if entry not in z.namelist():
                continue
            fields, methods, strings = parse_class(z.read(entry))
            found[cls] = {
                "jar": os.path.basename(jp),
                "fields": fields,
                "methods": [m for m in methods if not WANT[cls] or m[0] in WANT[cls]],
                "all_method_names": sorted({m[0] for m in methods}),
                "notable_strings": [s for s in strings if any(
                    k in s.lower() for k in ("topic", "gpu", "cef_server", "startup_test",
                                             "certificate", "ignore", "cache", "request_context")
                )][:30],
            }
    out = {
        "idea": IDEA,
        "jcef_jars": [os.path.basename(x) for x in jars],
        "classes": found,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    with open("build/probe-042-api.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
