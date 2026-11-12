import { Tab } from '../types';

class TabStorageService {
  private getStorageKey(userId: string): string {
    return `datauser_${userId}_tabs`;
  }

  saveTabs(userId: string, tabs: Tab[]): void {
    try {
      localStorage.setItem(this.getStorageKey(userId), JSON.stringify(tabs));
    } catch (error) {
      console.error('Failed to save tabs:', error.message);
    }
  }

  loadTabs(userId: string): Tab[] {
    try {
      const stored = localStorage.getItem(this.getStorageKey(userId));
      return stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error('Failed to load tabs:', error.message);
      return [];
    }
  }

  saveColumnConfig(userId: string, sourceId: string, config: any): void {
    try {
      const key = `datauser_${userId}_${sourceId}_columns`;
      localStorage.setItem(key, JSON.stringify(config));
    } catch (error) {
      console.error('Failed to save column config:', error.message);
    }
  }

  loadColumnConfig(userId: string, sourceId: string): any {
    try {
      const key = `datauser_${userId}_${sourceId}_columns`;
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error('Failed to load column config:', error.message);
      return null;
    }
  }
}

export const tabStorageService = new TabStorageService();
