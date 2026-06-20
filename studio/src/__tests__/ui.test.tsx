import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Toast, TableSkeleton, Empty } from '../components/ui';

describe('UI primitives', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Toast renders the message and auto-dismisses', () => {
    const onClose = vi.fn();
    render(<Toast message="Row saved." onClose={onClose} duration={1000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Row saved.');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Toast dismisses on the close button', () => {
    const onClose = vi.fn();
    render(<Toast message="Done." onClose={onClose} />);
    fireEvent.click(screen.getByLabelText(/dismiss/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('TableSkeleton exposes an accessible loading label', () => {
    render(<TableSkeleton columns={3} rows={2} label="Loading rows…" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading rows…');
  });

  it('Empty renders title, hint and an optional action', () => {
    render(
      <Empty
        title="No projects yet"
        hint="Create one to begin."
        action={<button>New project</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: /no projects yet/i })).toBeInTheDocument();
    expect(screen.getByText(/create one to begin/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument();
  });
});
