#!/usr/bin/env python3
"""Deployment patches for Kitware VolView v4.5.2 (run from the VolView checkout root).

Every patch must find its target EXACTLY ONCE; anything else exits non-zero so the
CodeBuild build FAILS instead of silently shipping an unpatched viewer (an upstream
release that moved the code must be re-reviewed, not skipped).

  (a) bearer token (globalHeaders) attached ONLY to same-origin requests: $fetch and
      the DICOMweb client. Plain HTTP(S) data fetches are same-origin only.
  (b) ?token= kept in this tab's sessionStorage so a reload still authenticates
      (VolView itself strips ?token= from the address bar); ?tokenUrl= disabled.
  (c) built-in sample datasets (data.kitware.com / GitHub links) removed; the
      ?urls= / ?names= launch params ignored; s3:// and gs:// sources refused.
      DICOMweb via ?dicomweb= is untouched.
  (d) remote save disabled (?save= ignored and the save target never set).
  (e) remote server / socket.io remote processing removed: the server store is a
      stub that never connects (no socket.io client in the bundle), and the
      Settings "Remote Server" URL field and the Remote module panel are gone.
  (f) Sentry error reporting removed: errorReporting.ts no longer imports
      @sentry/vue (capture calls are no-ops), and the Sentry vite plugin
      (source-map upload) is never configured.
  (g) DICOMweb host is same-origin only: a ?dicomweb= / VITE_DICOM_WEB_URL on
      another origin is ignored, and the user-entered "Host Address" setting
      (persisted in localStorage) is removed.
  (h) no itk-wasm CDN: every @itk-wasm/* package loads its WebAssembly pipelines
      from the locally shipped itk/ assets; the cdn.jsdelivr.net fallback in
      node_modules is removed and throws instead (run after npm ci).
"""
import re
import sys

FAILURES = []
# All edits are staged in memory and written only if EVERY patch matched, so a
# failed run never leaves a half-patched tree behind.
STAGED = {}
MARKER = 'Deployment patch ('


def _load(path):
    if path not in STAGED:
        with open(path, encoding='utf-8') as f:
            STAGED[path] = f.read()
    return STAGED[path]


def patch(path, old, new, label, regex=False):
    try:
        src = _load(path)
    except OSError as err:
        FAILURES.append(f'{label}: cannot read {path}: {err}')
        return
    if regex:
        count = len(re.findall(old, src, flags=re.S))
    else:
        count = src.count(old)
    if count != 1:
        FAILURES.append(f'{label}: expected exactly 1 match in {path}, found {count}')
        return
    if regex:
        STAGED[path] = re.sub(old, lambda _m: new, src, count=1, flags=re.S)
    else:
        STAGED[path] = src.replace(old, new, 1)
    print(f'PATCHED {label} ({path})')


# ---------------------------------------------------------------- (a) same-origin bearer
patch(
    'src/utils/fetch.ts',
    'export const globalHeaders = new Headers();\n',
    '''export const globalHeaders = new Headers();

// Deployment patch (a): the bearer token is sent ONLY to this deployment's own
// origin. Upstream attaches globalHeaders to every request, so a crafted launch
// URL pointing at another host would hand it the user's token.
export function isSameOrigin(input: RequestInfo | URL | string): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function headersFor(input: RequestInfo | URL | string): Headers {
  return isSameOrigin(input) ? new Headers(globalHeaders) : new Headers();
}
''',
    'a1 fetch.ts same-origin helper',
)
patch(
    'src/utils/fetch.ts',
    '  let headers = new Headers(globalHeaders);\n',
    '  let headers = headersFor(input);\n',
    'a2 fetch.ts $fetch uses same-origin headers',
)
patch(
    'src/utils/fetch.ts',
    '''    const { protocol } = parseUrl(url, window.location.href);
    return protocol === 'http:' || protocol === 'https:';
''',
    '''    // Deployment patch (c): plain HTTP(S) data fetches are same-origin only.
    const { protocol, origin } = parseUrl(url, window.location.href);
    return (
      (protocol === 'http:' || protocol === 'https:') &&
      origin === window.location.origin
    );
''',
    'a3 fetch.ts HTTP handler same-origin only',
)
patch(
    'src/core/dicom-web-api.ts',
    "import { globalHeaders } from '@/src/utils/fetch';\n",
    "import { headersFor } from '@/src/utils/fetch';\n",
    'a4 dicom-web-api.ts import',
)
patch(
    'src/core/dicom-web-api.ts',
    '  const headers = Object.fromEntries(globalHeaders.entries());\n',
    '  // Deployment patch (a): token only for a same-origin DICOMweb root.\n'
    '  const headers = Object.fromEntries(headersFor(dicomWebRoot).entries());\n',
    'a5 dicom-web-api.ts client headers same-origin only',
)

# ---------------------------------------------------------------- (b) token persistence
patch(
    'src/utils/token.ts',
    r'export async function populateAuthorizationToken\(.*\Z',
    '''const TOKEN_STORAGE_KEY = 'volview_token';

// Deployment patch (b): ?token= is remembered in this tab's sessionStorage (the
// URL copy is stripped by stripTokenFromUrl) so a reload stays authenticated.
// ?tokenUrl= is disabled: it fetched a bearer from an arbitrary URL.
export async function populateAuthorizationToken(
  urlParams: UrlParams = vtkURLExtract.extractURLParameters() as UrlParams
) {
  const raw = Array.isArray(urlParams.token)
    ? urlParams.token[0]
    : urlParams.token;
  let token = raw ? String(raw) : '';
  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      token = window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
    }
  } catch {
    // storage unavailable: the URL token (if any) still applies for this load
  }
  if (token) {
    setGlobalHeader('Authorization', `Bearer ${token}`);
  }
}
''',
    'b1 token.ts sessionStorage + no tokenUrl',
    regex=True,
)

# ---------------------------------------------------------------- (c) remote sources
patch(
    'src/config.ts',
    r'export const SAMPLE_DATA: SampleDataset\[\] = \[\n.*?\n\];\n',
    '// Deployment patch (c): no built-in remote sample datasets.\n'
    'export const SAMPLE_DATA: SampleDataset[] = [];\n',
    'c1 config.ts SAMPLE_DATA emptied',
    regex=True,
)
patch(
    'src/utils/urlParams.ts',
    '''    return normalizeUrlParams(
      vtkURLExtract.extractURLParameters() as UrlParams
    );
''',
    '''    // Deployment patch (c)/(d): the urls= / names= / save= launch params are
    // ignored (no arbitrary remote sources, no remote save target). Data comes
    // from ?dicomweb=, read separately by the DICOMweb store.
    return {};
''',
    'c2 urlParams.ts launch urls/save ignored',
)
patch(
    'src/io/import/processors/handleAmazonS3.ts',
    'const handleAmazonS3: ImportHandler = async (dataSource) => {\n',
    '''const handleAmazonS3: ImportHandler = async (dataSource) => {
  // Deployment patch (c): s3:// remote sources are disabled.
  if (dataSource.type === 'uri' && isAmazonS3Uri(dataSource.uri)) {
    throw new Error('s3:// sources are disabled in this deployment');
  }
''',
    'c3 handleAmazonS3.ts refused',
)
patch(
    'src/io/import/processors/handleGoogleCloudStorage.ts',
    'const handleGoogleCloudStorage: ImportHandler = async (dataSource) => {\n',
    '''const handleGoogleCloudStorage: ImportHandler = async (dataSource) => {
  // Deployment patch (c): gs:// remote sources are disabled.
  if (dataSource.type === 'uri' && isGoogleCloudStorageUri(dataSource.uri)) {
    throw new Error('gs:// sources are disabled in this deployment');
  }
''',
    'c4 handleGoogleCloudStorage.ts refused',
)

# ---------------------------------------------------------------- (d) remote save
patch(
    'src/store/remote-save-state.ts',
    '    saveUrl.value = url;\n  };\n',
    '    // Deployment patch (d): remote save is disabled; an empty target keeps\n'
    '    // the save UI inert.\n'
    '    saveUrl.value = \'\';\n  };\n',
    'd1 remote-save-state.ts save target never set',
)

# ---------------------------------------------------------------- (e) remote server
patch(
    'src/store/server.ts',
    r"\Aimport RpcClient from '@/src/core/remote/client';\n.*"
    r"const \{ VITE_REMOTE_SERVER_URL \} = import\.meta\.env;\n.*"
    r"await client\.connect\(url\.value\);.*\Z",
    '''import { defineStore } from 'pinia';
import { markRaw, ref } from 'vue';

// Deployment patch (e): the remote-processing server (socket.io RPC) is removed.
// Nothing here can open a connection: there is no URL, connect() is a no-op and
// the socket.io client is no longer imported, so it is not in the bundle.
export enum ConnectionState {
  Disconnected,
  Pending,
  Connected,
}

const disabled = async (): Promise<never> => {
  throw new Error('The remote server is disabled in this deployment');
};

const client = {
  call: disabled as (name: string, args?: unknown[]) => Promise<any>,
  stream: disabled as (
    name: string,
    callback: (data: any) => void,
    args?: unknown[]
  ) => Promise<void>,
};

export const useServerStore = defineStore('server', () => {
  const url = ref('');
  const connState = ref<ConnectionState>(ConnectionState.Disconnected);

  async function connect() {}

  async function disconnect() {}

  function setUrl(newUrl: string) {
    void newUrl;
  }

  return {
    url,
    client: markRaw(client),
    connState,
    connect,
    disconnect,
    setUrl,
  };
});
''',
    'e1 server.ts stub (no socket.io, never connects)',
    regex=True,
)
patch(
    'src/components/Settings.vue',
    '''      <v-divider class="mt-2 mb-6"></v-divider>
      <server-settings />
''',
    '',
    'e2 Settings.vue Remote Server settings removed',
)
patch(
    'src/components/Settings.vue',
    "import ServerSettings from './ServerSettings.vue';\n",
    '',
    'e3 Settings.vue ServerSettings import removed',
)
patch(
    'src/components/Settings.vue',
    '    DicomWebSettings,\n    ServerSettings,\n',
    '    DicomWebSettings,\n',
    'e4 Settings.vue ServerSettings component removed',
)
patch(
    'src/components/ModulePanel.vue',
    "import ServerModule from './ServerModule.vue';\n",
    '',
    'e5 ModulePanel.vue ServerModule import removed',
)
patch(
    'src/components/ModulePanel.vue',
    '''const RemoteModule: Module = {
  name: 'Remote',
  icon: 'server-network',
  component: ServerModule,
};
''',
    '// Deployment patch (e): no Remote (server) module.\n',
    'e6 ModulePanel.vue Remote module removed',
)
patch(
    'src/components/ModulePanel.vue',
    '        ...(jobsModule.value ? [jobsModule.value] : []),\n        RemoteModule,\n',
    '        ...(jobsModule.value ? [jobsModule.value] : []),\n',
    'e7 ModulePanel.vue Remote module not listed',
)

# ---------------------------------------------------------------- (f) Sentry
patch(
    'src/utils/errorReporting.ts',
    r"\Aimport \{ getGPUInfo \} from '@/src/utils/gpuInfo';\n"
    r"import \* as Sentry from '@sentry/vue';\n.*Sentry\.init\(.*\Z",
    '''import { defineStore } from 'pinia';
import { App, ref } from 'vue';

// Deployment patch (f): Sentry error reporting is removed. Nothing is sent to
// any error-reporting service; @sentry/vue is not imported, so it is not in
// the bundle. The store and exports stay so the settings UI still compiles.
export const LOCAL_STORAGE_KEY = 'error-reporting-off';

export const errorReportingConfigured = false;

export const init = (app: App<Element>) => {
  void app;
};

export const captureException = (err: unknown) => {
  void err;
};

export const captureMessage = (message: string, context?: unknown) => {
  void message;
  void context;
};

export const useErrorReporting = defineStore('error-reporting', () => {
  const disableReporting = ref(true);
  return { disableReporting };
});
''',
    'f1 errorReporting.ts Sentry removed',
    regex=True,
)
patch(
    'src/composables/useGlobalErrorHook.ts',
    "import { captureException } from '@sentry/vue';\n",
    "import { captureException } from '@/src/utils/errorReporting';\n",
    'f2 useGlobalErrorHook.ts no Sentry',
)
patch(
    'src/composables/useWebGLWatchdog.ts',
    "import { captureMessage } from '@sentry/vue';\n",
    "import { captureMessage } from '@/src/utils/errorReporting';\n",
    'f3 useWebGLWatchdog.ts no Sentry',
)
patch(
    'vite.config.ts',
    "import { sentryVitePlugin } from '@sentry/vite-plugin';\n",
    '',
    'f4 vite.config.ts Sentry plugin import removed',
)
patch(
    'vite.config.ts',
    '''const { ANALYZE_BUNDLE, SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT } =
  process.env;
''',
    'const { ANALYZE_BUNDLE } = process.env;\n',
    'f5 vite.config.ts SENTRY_* env ignored',
)
patch(
    'vite.config.ts',
    r'function configureSentryPlugin\(\) \{\n  return SENTRY_AUTH_TOKEN.*?\n\}\n',
    '''// Deployment patch (f): never upload source maps to Sentry.
function configureSentryPlugin() {
  return {} as Plugin;
}
''',
    'f6 vite.config.ts Sentry plugin never configured',
    regex=True,
)

# ---------------------------------------------------------------- (g) DICOMweb host
patch(
    'src/store/dicom-web/dicom-web-store.ts',
    '''  // Don't save URL param or env var to local storage. Only save user input.
  const savedHost = useLocalStorage<string | null>('dicomWebHost', ''); // null if cleared by vuetify text input

  const host = ref<string | null>(hostConfig ?? savedHost.value);

  watch(savedHost, () => {
    host.value = savedHost.value;
  });
''',
    '''  // Deployment patch (g): the DICOMweb host is this deployment's own origin
  // only. A ?dicomweb= (or VITE_DICOM_WEB_URL) on another origin is ignored,
  // and there is no user-entered host (no localStorage value, no settings field).
  const sameOriginHost = (h: string | null | undefined): string | null => {
    if (!h) return null;
    try {
      const resolved = new URL(h, window.location.href);
      return resolved.origin === window.location.origin ? resolved.href : null;
    } catch {
      return null;
    }
  };
  const savedHost = ref<string | null>('');

  const host = ref<string | null>(sameOriginHost(hostConfig));
''',
    'g1 dicom-web-store.ts host same-origin only, no saved host',
)
patch(
    'src/components/dicom-web/DicomWebSettings.vue',
    '''    <v-text-field
      v-model="dicomWeb.savedHost"
      class="server-param"
      label="Host Address"
      clearable
    />
''',
    '',
    'g2 DicomWebSettings.vue Host Address field removed',
)

# ---------------------------------------------------------------- (h) itk-wasm CDN
# Each @itk-wasm/* package falls back to downloading its WebAssembly pipelines
# from cdn.jsdelivr.net when no base URL is set. @itk-wasm/morphological-contour-
# interpolation bundles its OWN itk-wasm copy, so upstream main.js's global
# setPipelinesBaseUrl() never reaches it and the Fill Between tool loads remote
# code from the CDN. Point every package at the locally shipped itk/ pipelines,
# and make the CDN fallback itself throw (runs after npm ci, before the build).
patch(
    'src/main.js',
    "import { setPipelinesBaseUrl as imageIoSetPipelinesBaseUrl } from '@itk-wasm/image-io';\n",
    "import { setPipelinesBaseUrl as imageIoSetPipelinesBaseUrl } from '@itk-wasm/image-io';\n"
    "import { setPipelinesBaseUrl as dicomSetPipelinesBaseUrl } from '@itk-wasm/dicom';\n"
    "import { setPipelinesBaseUrl as morphSetPipelinesBaseUrl } from '@itk-wasm/morphological-contour-interpolation';\n",
    'h1 main.js import per-package pipeline base URL setters',
)
patch(
    'src/main.js',
    'imageIoSetPipelinesBaseUrl(itkConfig.imageIOUrl);\n',
    'imageIoSetPipelinesBaseUrl(itkConfig.imageIOUrl);\n'
    '// Deployment patch (h): every itk-wasm package uses the locally shipped\n'
    '// pipelines, never the jsdelivr CDN default.\n'
    'dicomSetPipelinesBaseUrl(itkConfig.pipelinesUrl);\n'
    'morphSetPipelinesBaseUrl(itkConfig.pipelinesUrl);\n',
    'h2 main.js set dicom + morphological pipeline base URLs',
)
for pkg in ('image-io', 'dicom', 'morphological-contour-interpolation'):
    target = f'node_modules/@itk-wasm/{pkg}/dist/pipelines-base-url.js'
    patch(
        target,
        r'let defaultPipelinesBaseUrl = `https://cdn\.jsdelivr\.net/npm/@itk-wasm/'
        + re.escape(pkg) + r'@\$\{version\}/dist/pipelines`;\n',
        '// Deployment patch (h): no CDN default for the WebAssembly pipelines.\n',
        f'h3 {pkg} pipelines-base-url.js CDN default removed',
        regex=True,
    )
    patch(
        target,
        '    return defaultPipelinesBaseUrl;\n',
        "    throw new Error('itk-wasm pipelines base URL is not set (CDN fallback disabled)');\n",
        f'h4 {pkg} pipelines-base-url.js fallback throws',
    )

for staged_path, staged_src in STAGED.items():
    try:
        with open(staged_path, encoding='utf-8') as f:
            if MARKER in f.read():
                FAILURES.append(f'{staged_path} is already patched (run on a fresh checkout)')
    except OSError:
        pass

if FAILURES:
    for msg in FAILURES:
        print(f'PATCH FAILED: {msg}', file=sys.stderr)
    print('No files were modified.', file=sys.stderr)
    sys.exit(1)
for staged_path, staged_src in STAGED.items():
    with open(staged_path, 'w', encoding='utf-8') as f:
        f.write(staged_src)
print(f'All VolView deployment patches applied ({len(STAGED)} files).')
