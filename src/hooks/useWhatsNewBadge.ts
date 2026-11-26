'use client';

import { useEffect, useState } from 'react';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

/** Whether What's New has a release the person has not opened yet: the dot on More and on its What's New row. */
export function useWhatsNewBadge() {
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    const check = () => {
      const lastSeen = Number(localStorage.getItem(WHATS_NEW_STORAGE_KEY) || '0');
      setHasNew(LATEST_RELEASE.id > lastSeen);
    };
    check();
    window.addEventListener('whats-new-seen', check);
    return () => window.removeEventListener('whats-new-seen', check);
  }, []);

  return hasNew;
}
