import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Login } from '../screens/Login';

describe('Login screen', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the admin-key field and shows it without a backend', () => {
    render(<Login onSignedIn={() => {}} />);
    expect(screen.getByLabelText(/admin key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('blocks empty key submission', async () => {
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/paste your admin key/i);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('validates then calls onSignedIn on success', async () => {
    // validate() calls /health then /stats — return a fresh Response each time.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: 'svc-key' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith({ baseUrl: '/admin', key: 'svc-key' }));
    expect(sessionStorage.getItem('laetoli.studio.adminKey')).toBe('svc-key');
  });

  it('surfaces a rejected key', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('no', { status: 401 }));
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i);
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
