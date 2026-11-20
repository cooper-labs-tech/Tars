'use client';

import { Suspense } from 'react';
import { TracesPage } from '@/components/Traces';

export default function Traces() {
  return (
    <Suspense>
      <TracesPage />
    </Suspense>
  );
}
