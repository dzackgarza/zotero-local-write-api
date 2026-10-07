/**
 * The fixture server stands in for a publisher in the live import suites. Its
 * routes are set per test, so one URL can serve different pages over time.
 */
type Fixture = { body: string; type: string };

export class FixtureServer {
  private readonly fixtures = new Map<string, Fixture>();
  private readonly server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => this.answer(request),
  });

  /** Serve `fixture` at `path` and return its absolute URL. */
  serve(path: string, fixture: Fixture): string {
    this.fixtures.set(path, fixture);
    return `http://127.0.0.1:${this.server.port}${path}`;
  }

  servePage(path: string, head: string, body = "<p>fixture</p>"): string {
    return this.serve(path, {
      body: `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
      type: "text/html; charset=utf-8",
    });
  }

  /**
   * Serve a one-page PDF whose only text is `text`: no DOI, ISBN or arXiv ID,
   * so neither Zotero's recognizer nor identifier discovery can name the work.
   */
  servePdf(path: string, text: string): string {
    return this.serve(path, { body: pdfDocument(pdfObjects(text)), type: "application/pdf" });
  }

  stop(): void {
    this.server.stop(true);
  }

  private answer(request: Request): Response {
    const fixture = this.fixtures.get(new URL(request.url).pathname);
    if (fixture === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(fixture.body, { headers: { "Content-Type": fixture.type } });
  }
}

/** The head of a page that carries only Highwire `citation_*` tags. */
export function citationHead(title: string): string {
  return [
    `<title>${title}</title>`,
    `<meta name="citation_title" content="${title}">`,
    `<meta name="citation_author" content="Fixture, Ada">`,
    `<meta name="citation_publication_date" content="2021/03/04">`,
    `<meta name="citation_journal_title" content="Journal of Fixtures">`,
  ].join("");
}

/** The objects of a one-page PDF that shows `text` in Helvetica. */
function pdfObjects(text: string): string[] {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  return [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
}

/** Layout per ISO 32000-1 section 7.5: header, objects, xref table, trailer. */
function pdfDocument(objects: string[]): string {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}
