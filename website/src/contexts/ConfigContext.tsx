import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface Config {}

interface ConfigContextType {
  config: Config | null;
  loading: boolean;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

export const useConfig = (): ConfigContextType => {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
};

interface ConfigProviderProps {
  children: ReactNode;
}

export const ConfigProvider: React.FC<ConfigProviderProps> = ({ children }) => {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const runtimeConfig = (window as any).REACT_APP_CONFIG || {};
        setConfig({});
      } catch (error) {
        console.error('Failed to load config:', { errorType: error.name });
        setConfig({});
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, []);

  return (
    <ConfigContext.Provider value={{ config, loading }}>
      {children}
    </ConfigContext.Provider>
  );
};
