"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function GoBackButton() {
  const router = useRouter();
  return (
    <Button variant="secondary" onClick={() => router.back()}>
      Go back
    </Button>
  );
}
