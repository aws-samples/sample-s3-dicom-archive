import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

class ResizeObserverErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Cloudscape components can sometimes throw ResizeObserver errors
    // which are generally safe to ignore
    if (error.message && error.message.includes('ResizeObserver')) {
      console.warn('ResizeObserver error caught:', error);
      // Reset the error state to allow the component to render normally
      this.setState({ hasError: false });
    } else {
      console.error('Error caught by error boundary:', error, errorInfo);
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      // You can render any custom fallback UI
      return <h1>Something went wrong.</h1>;
    }

    return this.props.children;
  }
}

export default ResizeObserverErrorBoundary;
