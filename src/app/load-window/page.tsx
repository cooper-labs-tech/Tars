'use client';

import LoadWindowPage from '@/components/LoadWindow';

/** The Load window's own route; the new interface opens it as a card of More (`Shell · Load window card · *`). */
export default function LoadWindow() {
  return (
    <div className="h-[calc(100vh-44px)] flex flex-col">
      <LoadWindowPage />
    </div>
  );
}
