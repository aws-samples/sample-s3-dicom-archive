import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Alert, Box, Button, Container, Header } from '@cloudscape-design/components';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({
      error,
      errorInfo
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <Container
          header={
            <Header variant="h1">
              Something went wrong
            </Header>
          }
        >
          <Alert
            type="error"
            header="Application Error"
            action={
              <Button onClick={this.handleReset}>
                Return to Home
              </Button>
            }
          >
            <Box variant="p">
              An unexpected error occurred. Please try again or contact support if the problem persists.
            </Box>
            {this.state.error && (
              <Box variant="code" margin={{ top: 's' }}>
                {this.state.error.toString()}
              </Box>
            )}
            {this.state.errorInfo && (
              <details style={{ marginTop: '1rem', whiteSpace: 'pre-wrap' }}>
                <summary>Error Details</summary>
                {this.state.errorInfo.componentStack}
              </details>
            )}
          </Alert>
        </Container>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
