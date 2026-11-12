export interface Application {
  id: string;
  name: string;
  type: 'ohif' | 'slim' | 'download' | 'viewer' | 'custom';
  url?: string;
  icon?: string;
  /** Whether one launch can take several studies. Default: every type except 'slim'. */
  multiStudy?: boolean;
}

export interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolWebClientId: string;
  virtualFolderEnabled: boolean;
  applications: Application[];
  dicomWebUrl: string;
  virtualFolderDicomWebUrl: string;
  ohifViewerUrl?: string;
  slimViewerUrl?: string;
  /** VolView base URL ("" / absent when config.json volviewFeature is off). */
  volviewViewerUrl?: string;
  version: string;
}

class ConfigService {
  private config: AppConfig | null = null;

  async loadConfig(): Promise<AppConfig> {
    if (this.config) {
      return this.config;
    }

    try {
      // config.json is deployed alongside the app under the Vite base
      // (e.g. /data-user/). Use BASE_URL so it resolves correctly regardless of
      // the current route; a root-absolute '/config.json' 404s under the base.
      const response = await fetch(`${import.meta.env.BASE_URL}config.json`);
      const config = await response.json();
      const region = config.region || 'us-east-1';
      
      this.config = {
        apiUrl: config.apiUrl || '',
        region,
        userPoolId: config.userPoolId || '',
        userPoolWebClientId: config.userPoolWebClientId || '',
        virtualFolderEnabled: config.virtualFolderEnabled !== undefined ? config.virtualFolderEnabled : true,
        // 'download' apps stay in the list; StudyTable and Preferences offer
        // them only where the server says the user holds canDownload
        // (dicomwebService.canDownload), and the server enforces it.
        applications: config.applications || [],
        dicomWebUrl: config.dicomWebUrl
          || (config.virtualFolderDicomWebUrl ? config.virtualFolderDicomWebUrl.replace(/\/virtual-folders\/?$/, '') + '/dicomweb' : '')
          || '',
        virtualFolderDicomWebUrl: config.virtualFolderDicomWebUrl || '',
        ohifViewerUrl: config.ohifViewerUrl,
        slimViewerUrl: config.slimViewerUrl,
        volviewViewerUrl: config.volviewViewerUrl || '',
        version: config.version
      };

      return this.config;
    } catch (error) {
      console.error('Failed to load config:', error.message);
      throw new Error('Failed to load application configuration');
    }
  }

  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('Config not loaded. Call loadConfig() first.');
    }
    return this.config;
  }
}

export const configService = new ConfigService();
