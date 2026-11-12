import React from 'react';

// Enhanced ResizeObserver error suppression utility
// This addresses the persistent "ResizeObserver loop completed with undelivered notifications" error
// that occurs with CloudScape Design System components

export const suppressResizeObserverErrors = () => {
  // Store original methods
  const originalError = console.error;
  const originalWarn = console.warn;

  // Enhanced console error suppression
  console.error = (...args: any[]) => {
    const message = args[0];
    if (
      typeof message === 'string' &&
      (message.includes('ResizeObserver loop completed with undelivered notifications') ||
       message.includes('ResizeObserver loop limit exceeded'))
    ) {
      // Completely suppress these errors
      return;
    }
    originalError.apply(console, args);
  };

  // Also suppress warnings related to ResizeObserver
  console.warn = (...args: any[]) => {
    const message = args[0];
    if (
      typeof message === 'string' &&
      (message.includes('ResizeObserver') ||
       message.includes('loop completed') ||
       message.includes('undelivered notifications'))
    ) {
      return;
    }
    originalWarn.apply(console, args);
  };

  // Enhanced window error handler
  const handleWindowError = (e: ErrorEvent) => {
    if (
      e.message &&
      (e.message.includes('ResizeObserver loop completed with undelivered notifications') ||
       e.message.includes('ResizeObserver loop limit exceeded') ||
       e.message.includes('deliverResizeLoopError'))
    ) {
      e.stopImmediatePropagation();
      e.preventDefault();
      return false;
    }
  };

  // Enhanced unhandled rejection handler
  const handleUnhandledRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    if (
      reason &&
      typeof reason === 'object' &&
      reason.message &&
      (reason.message.includes('ResizeObserver loop completed with undelivered notifications') ||
       reason.message.includes('ResizeObserver loop limit exceeded'))
    ) {
      e.preventDefault();
      return false;
    }
  };

  // Add event listeners
  window.addEventListener('error', handleWindowError, true);
  window.addEventListener('unhandledrejection', handleUnhandledRejection, true);

  // Override the global ResizeObserver to add error handling
  if (typeof window !== 'undefined' && window.ResizeObserver) {
    const OriginalResizeObserver = window.ResizeObserver;
    
    window.ResizeObserver = class extends OriginalResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        const wrappedCallback: ResizeObserverCallback = (entries, observer) => {
          try {
            callback(entries, observer);
          } catch (error) {
            // Suppress ResizeObserver-related errors
            if (
              error instanceof Error &&
              (error.message.includes('ResizeObserver loop completed with undelivered notifications') ||
               error.message.includes('ResizeObserver loop limit exceeded'))
            ) {
              return;
            }
            // Re-throw other errors
            throw error;
          }
        };
        super(wrappedCallback);
      }
    };
  }

  // Additional error suppression for React error boundaries
  const originalReactError = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__?.onCommitFiberRoot;
  if (originalReactError) {
    (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot = (...args: any[]) => {
      try {
        return originalReactError.apply(this, args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('ResizeObserver loop completed with undelivered notifications')
        ) {
          return;
        }
        throw error;
      }
    };
  }

  // Return cleanup function
  return () => {
    console.error = originalError;
    console.warn = originalWarn;
    window.removeEventListener('error', handleWindowError, true);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection, true);
  };
};

// Debounced ResizeObserver wrapper to prevent rapid-fire observations
export class DebouncedResizeObserver {
  private observer: ResizeObserver;
  private timeout: NodeJS.Timeout | null = null;
  private callback: ResizeObserverCallback;
  private delay: number;

  constructor(callback: ResizeObserverCallback, delay: number = 100) {
    this.callback = callback;
    this.delay = delay;
    
    this.observer = new ResizeObserver((entries, observer) => {
      if (this.timeout) {
        clearTimeout(this.timeout);
      }
      
      this.timeout = setTimeout(() => {
        try {
          this.callback(entries, observer);
        } catch (error) {
          // Suppress ResizeObserver errors
          if (error instanceof Error && 
              (error.message.includes('ResizeObserver loop completed with undelivered notifications') ||
               error.message.includes('ResizeObserver loop limit exceeded'))) {
            return;
          }
          throw error;
        }
      }, this.delay);
    });
  }

  observe(target: Element, options?: ResizeObserverOptions) {
    try {
      this.observer.observe(target, options);
    } catch (error) {
      // Suppress ResizeObserver errors during observation
      if (error instanceof Error && 
          error.message.includes('ResizeObserver loop completed with undelivered notifications')) {
        return;
      }
      throw error;
    }
  }

  unobserve(target: Element) {
    try {
      this.observer.unobserve(target);
    } catch (error) {
      // Suppress errors during unobservation
      if (error instanceof Error && 
          error.message.includes('ResizeObserver loop completed with undelivered notifications')) {
        return;
      }
      throw error;
    }
  }

  disconnect() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    try {
      this.observer.disconnect();
    } catch (error) {
      // Suppress errors during disconnect
      if (error instanceof Error && 
          error.message.includes('ResizeObserver loop completed with undelivered notifications')) {
        return;
      }
      throw error;
    }
  }
}

// Additional utility to suppress errors in specific components
export const withResizeObserverErrorSuppression = <T extends React.ComponentType<any>>(
  Component: T
): T => {
  const WrappedComponent = (props: any) => {
    React.useEffect(() => {
      const cleanup = suppressResizeObserverErrors();
      return cleanup;
    }, []);

    return React.createElement(Component, props);
  };

  WrappedComponent.displayName = `withResizeObserverErrorSuppression(${Component.displayName || Component.name})`;
  
  return WrappedComponent as T;
};
