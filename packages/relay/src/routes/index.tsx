import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <main className="site-shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Remote Control</p>
        <h1 id="page-title">Continue Codex from iMessage.</h1>
        <p>
          Remote Control installs a local Codex skill and connects it to an iMessage relay.
          Start it in any Codex thread, pair your phone once, then text your next instruction while you are away.
        </p>
        <code>npx @gaberagland/remote-control install</code>
        <p className="fine-print">
          This command uses the hosted relay by default. You can also deploy your own Cloudflare relay from the
          public GitHub repo.
        </p>
        <div className="links" aria-label="Remote Control links">
          <a href="https://github.com/gragland/remote-control">GitHub</a>
          <a href="https://github.com/gragland/remote-control/tree/main/packages/relay#self-hosting">
            Self-hosting
          </a>
        </div>
      </section>
    </main>
  );
}
