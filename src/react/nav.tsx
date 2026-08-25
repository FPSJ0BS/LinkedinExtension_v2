// The navigation shared by every extension page.
//
// One list, in one file, so a page cannot go missing from one menu and not
// another — which is exactly what happens when four pages each hand-write their
// own links. Adding a page here adds it everywhere.

// React 16.0.0 is a global, not an import, and it has no hooks, no Fragments
// and no createRoot. Class components only — see CLAUDE.md.
const React: any = (globalThis as any).React;

export interface NavPage {
  id: string;
  label: string;
  url: string;
  hint: string;
}

/**
 * Every page this extension renders, in the order a person works through them:
 * collect, review, then reach out.
 */
export const NAV_PAGES: NavPage[] = [
  { id: "dashboard", label: "Profiles", url: "dashboard.html", hint: "Saved profiles and CSV export" },
  { id: "applicants", label: "Applicants", url: "applicants.html", hint: "Applicants on your job posts" },
  { id: "messages", label: "Messages", url: "messages.html", hint: "Templates and messages" },
  { id: "import", label: "Import", url: "import.html", hint: "Bulk collection from connections" }
];

/**
 * The bar itself.
 *
 * `current` marks the page being viewed, and it is marked with `aria-current`
 * rather than only a class, so the mark is readable by something other than the
 * stylesheet — the same standard rule 7 holds LinkedIn's own markup to.
 */
export class NavBar extends React.Component<{ current: string }> {
  render() {
    const current = this.props.current;
    return (
      <nav className="pv-nav" aria-label="Extension pages">
        <span className="pv-nav-brand">Profile Vault</span>
        <ul className="pv-nav-list">
          {NAV_PAGES.map((page: NavPage) => (
            <li className="pv-nav-item" key={page.id}>
              <a
                className={page.id === current ? "pv-nav-link pv-nav-link-current" : "pv-nav-link"}
                href={page.url}
                title={page.hint}
                aria-current={page.id === current ? "page" : undefined}
              >
                {page.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    );
  }
}
