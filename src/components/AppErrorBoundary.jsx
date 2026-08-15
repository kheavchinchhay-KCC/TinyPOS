import React from "react";
import { reportClientError } from "../lib/errorReporting";
import { APP_RELEASE_LABEL } from "../lib/release";

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportClientError(
      error,
      {
        event: "react.error_boundary",
        component_stack: info?.componentStack || null
      },
      "critical"
    );
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="fatal-error-screen">
        <section>
          <div className="fatal-error-mark">!</div>
          <h1>Tiny POS encountered an error</h1>
          <p>
            Tiny POS មានបញ្ហាដែលមិនបានរំពឹងទុក។
            Your work may still be saved locally. Reload the app and review
            System Health when the problem continues.
          </p>
          <code>{this.state.error.message}</code>
          <div>
            <button
              type="button"
              className="primary-button"
              onClick={() => window.location.reload()}
            >
              Reload Tiny POS
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                window.location.href = "/dashboard";
              }}
            >
              Open Dashboard
            </button>
          </div>
          <small>{APP_RELEASE_LABEL}</small>
        </section>
      </main>
    );
  }
}
