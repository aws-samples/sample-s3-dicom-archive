// Aggressive ResizeObserver error suppression
// This script runs before React and patches the ResizeObserver at the browser level

(function() {
  'use strict';

  // Store original methods
  const originalError = window.console.error;
  const originalWarn = window.console.warn;

  // Override console.error to suppress ResizeObserver errors
  window.console.error = function(...args) {
    const message = args[0];
    if (typeof message === 'string' && 
        (message.includes('ResizeObserver loop completed with undelivered notifications') ||
         message.includes('ResizeObserver loop limit exceeded') ||
         message.includes('deliverResizeLoopError'))) {
      return; // Suppress these errors completely
    }
    return originalError.apply(console, args);
  };

  // Override console.warn for ResizeObserver warnings
  window.console.warn = function(...args) {
    const message = args[0];
    if (typeof message === 'string' && 
        (message.includes('ResizeObserver') ||
         message.includes('loop completed') ||
         message.includes('undelivered notifications'))) {
      return; // Suppress these warnings
    }
    return originalWarn.apply(console, args);
  };

  // Global error handler
  window.addEventListener('error', function(e) {
    if (e.message && 
        (e.message.includes('ResizeObserver loop completed with undelivered notifications') ||
         e.message.includes('ResizeObserver loop limit exceeded') ||
         e.message.includes('deliverResizeLoopError'))) {
      e.stopImmediatePropagation();
      e.preventDefault();
      return false;
    }
  }, true);

  // Global unhandled rejection handler
  window.addEventListener('unhandledrejection', function(e) {
    if (e.reason && 
        e.reason.message && 
        (e.reason.message.includes('ResizeObserver loop completed with undelivered notifications') ||
         e.reason.message.includes('ResizeObserver loop limit exceeded'))) {
      e.preventDefault();
      return false;
    }
  }, true);

  // Patch ResizeObserver constructor if available
  if (window.ResizeObserver) {
    const OriginalResizeObserver = window.ResizeObserver;
    
    window.ResizeObserver = function(callback) {
      const wrappedCallback = function(entries, observer) {
        try {
          return callback(entries, observer);
        } catch (error) {
          if (error.message && 
              (error.message.includes('ResizeObserver loop completed with undelivered notifications') ||
               error.message.includes('ResizeObserver loop limit exceeded'))) {
            return; // Suppress the error
          }
          throw error; // Re-throw other errors
        }
      };
      
      return new OriginalResizeObserver(wrappedCallback);
    };
    
    // Copy static properties
    Object.setPrototypeOf(window.ResizeObserver, OriginalResizeObserver);
    Object.defineProperty(window.ResizeObserver, 'prototype', {
      value: OriginalResizeObserver.prototype,
      writable: false
    });
  }

  // Additional protection for React DevTools
  const originalDevToolsHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (originalDevToolsHook && originalDevToolsHook.onCommitFiberRoot) {
    const originalOnCommit = originalDevToolsHook.onCommitFiberRoot;
    originalDevToolsHook.onCommitFiberRoot = function(...args) {
      try {
        return originalOnCommit.apply(this, args);
      } catch (error) {
        if (error.message && 
            error.message.includes('ResizeObserver loop completed with undelivered notifications')) {
          return; // Suppress the error
        }
        throw error;
      }
    };
  }

  console.log('ResizeObserver error suppression initialized');
})();
