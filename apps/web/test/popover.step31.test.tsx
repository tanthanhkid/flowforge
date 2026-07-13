/**
 * SPEC-step31.md §F3 — `ui/Popover.tsx`'s new optional `onClose`: outside
 * mousedown (capture, target neither in the portaled panel nor the anchor)
 * and Escape both call it; a mousedown inside the panel or on the anchor
 * itself does not (the anchor's own `onClick` toggle already owns that
 * case — see the file header comment in Popover.tsx for why). Omitting
 * `onClose` entirely must leave the component exactly as display-only as it
 * was before this step (no listener attached, no behavior change for
 * existing callers).
 */
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Popover } from '../src/ui/Popover.tsx';

afterEach(() => {
  cleanup();
});

/** Renders an anchor button, an "outside" sibling, and a togglable Popover under it. */
function Harness({ withOnClose }: { withOnClose: boolean }) {
  const [show, setShow] = useState(true);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={anchorRef} type="button" data-testid="anchor">
        Anchor
      </button>
      <div data-testid="outside">Outside content</div>
      {show && (
        <Popover anchorRef={anchorRef} onClose={withOnClose ? () => setShow(false) : undefined}>
          <div data-testid="panel-content">Panel content</div>
        </Popover>
      )}
    </div>
  );
}

describe('Popover — onClose (SPEC-step31.md §F3)', () => {
  it('a mousedown outside both the panel and the anchor calls onClose', () => {
    render(<Harness withOnClose />);
    expect(screen.getByTestId('panel-content')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));

    expect(screen.queryByTestId('panel-content')).not.toBeInTheDocument();
  });

  it('an Escape keydown calls onClose', () => {
    render(<Harness withOnClose />);
    expect(screen.getByTestId('panel-content')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('panel-content')).not.toBeInTheDocument();
  });

  it('a mousedown inside the panel does not call onClose', () => {
    render(<Harness withOnClose />);

    fireEvent.mouseDown(screen.getByTestId('panel-content'));

    expect(screen.getByTestId('panel-content')).toBeInTheDocument();
  });

  it('a mousedown on the anchor itself does not call onClose (the trigger owns its own toggle)', () => {
    render(<Harness withOnClose />);

    fireEvent.mouseDown(screen.getByTestId('anchor'));

    expect(screen.getByTestId('panel-content')).toBeInTheDocument();
  });

  it('omitting onClose keeps the popover display-only — outside mousedown and Escape do nothing', () => {
    render(<Harness withOnClose={false} />);

    fireEvent.mouseDown(screen.getByTestId('outside'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByTestId('panel-content')).toBeInTheDocument();
  });
});
