import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 出错时的标题，便于定位是哪一块挂了 */
  label?: string;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * 错误边界。
 *
 * 为什么需要：没有它，任何一个组件抛异常都会让整个 React 树卸载，
 * 用户看到的是一片白——完全无法判断出了什么事。
 * 实测踩到过：错题本里一条字段不全的脏数据直接把整个应用打白屏。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 保留组件栈，方便定位
    this.setState({ info: info.componentStack ?? '' });
    console.error('[词域] 界面渲染出错:', error, info.componentStack);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="pad center-col" style={{ gap: 16 }}>
        <div className="hero" style={{ padding: 22 }}>
          <h1 style={{ marginTop: 0, fontSize: 19 }}>这一块界面出错了</h1>
          <div className="small muted" style={{ lineHeight: 1.75 }}>
            {this.props.label ? `出错位置：${this.props.label}` : '界面渲染时抛出了异常。'}
            <br />
            你的学习数据都在本地，没有丢失。可以刷新页面重试。
          </div>

          <div
            className="small"
            style={{
              marginTop: 14,
              padding: '11px 13px',
              borderRadius: 12,
              background: 'var(--again-soft)',
              border: '1px solid #ffc9c9',
              color: '#c25050',
              fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
              wordBreak: 'break-word',
              lineHeight: 1.6,
            }}
          >
            {error.name}: {error.message}
          </div>

          {info && (
            <details style={{ marginTop: 12 }}>
              <summary className="small faint" style={{ cursor: 'pointer' }}>
                查看组件调用栈
              </summary>
              <pre
                className="tiny faint"
                style={{ whiteSpace: 'pre-wrap', marginTop: 8, lineHeight: 1.6 }}
              >
                {info.trim()}
              </pre>
            </details>
          )}

          <div className="row gap12" style={{ marginTop: 18 }}>
            <button className="primary big" onClick={() => location.reload()}>
              刷新页面
            </button>
            <button
              className="big"
              onClick={() => this.setState({ error: null, info: '' })}
            >
              仅重试这一块
            </button>
          </div>
        </div>
      </div>
    );
  }
}
