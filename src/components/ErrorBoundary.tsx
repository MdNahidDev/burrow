import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Unexpected rendering error occurred.',
    };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Handled calmly by fallback UI
  }

  handleReset = () => {
    this.setState({ hasError: false, message: '' });
  };

  handleClearLocalAndReload = () => {
    try {
      window.localStorage.removeItem('burrow_windows_local_state_v1');
    } catch {
      // Ignore storage failures
    }
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        className="min-h-screen flex items-center justify-center p-6 text-[var(--text-primary)]"
        style={{ background: 'var(--backdrop-clean)' }}
      >
        <div className="max-w-md w-full rounded-2xl glass-panel p-6 space-y-4 text-center">
          <h1 className="text-base font-semibold text-[var(--text-primary)]">
            Burrow recovered from a view error
          </h1>
          <p className="text-xs text-[var(--text-secondary)]">
            {this.state.message}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2.5 pt-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="px-4 py-2 text-xs font-semibold rounded-full bg-[var(--pill-active-bg)] text-[var(--pill-active-text)] hover:opacity-90 transition-opacity"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleClearLocalAndReload}
              className="px-4 py-2 text-xs font-medium rounded-full glass-panel glass-panel-hover text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Reset presets & reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
