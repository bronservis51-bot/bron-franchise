import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CredentialFields } from '../../src/ui/CredentialFields';

describe('account credentials', () => {
  it('renders a separate action for each newly issued field', () => {
    const html = renderToStaticMarkup(<CredentialFields login="+7 900 000-00-00" password="demo-starting-password" />);
    expect(html).toContain('Скопировать логин');
    expect(html).toContain('Скопировать пароль');
    expect(html.match(/<button\b/g)).toHaveLength(2);
  });

  it('shows only the login action when an existing account is viewed', () => {
    const html = renderToStaticMarkup(<CredentialFields login="existing-account" />);
    expect(html).toContain('Скопировать логин');
    expect(html).not.toContain('Скопировать пароль');
  });

  it('does not offer to copy an empty password', () => {
    const html = renderToStaticMarkup(<CredentialFields login="existing-account" password="" />);
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });
});
