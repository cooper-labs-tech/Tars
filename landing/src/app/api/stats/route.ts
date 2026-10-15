import { NextResponse } from 'next/server';
import { releaseStats } from '../../../lib/downloads';

// GitHub's count of .dmg downloads, and for each system the version of its
// newest build, read and cached by the server, so no visitor's browser asks
// GitHub. Both are null when GitHub did not answer; the page then shows no
// count, and offers every system, the download route deciding.
export async function GET() {
  return NextResponse.json(await releaseStats());
}
