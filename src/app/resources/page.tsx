'use client';

import { Suspense } from 'react';
import { ResourcesPage } from '@/components/Resources';

export default function Resources() {
  return (
    <Suspense>
      <ResourcesPage />
    </Suspense>
  );
}
