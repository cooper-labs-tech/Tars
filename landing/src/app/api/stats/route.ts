import { NextResponse } from 'next/server';
import { releaseStats } from '../../../lib/downloads';

// GitHub's count of installer downloads, for each system the version of its
// newest build, and the newest published release, read and cached by the
// server, so no visitor's browser asks GitHub. All are null when GitHub did not
// answer; the page then shows no count, and offers every system, the download
// route deciding.
export async function GET() {
  return NextResponse.json(await releaseStats());
}
