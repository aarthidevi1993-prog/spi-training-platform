"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { certificateVerificationPath } from "@/types/certificate";

/**
 * Manual lookup: builds /verify/<number>?code=<code>. Only navigates —
 * the server page does the verification.
 */
export function VerifyCertificateForm({ defaultNumber = "" }: { defaultNumber?: string }) {
  const router = useRouter();
  const [number, setNumber] = useState(defaultNumber);
  const [code, setCode] = useState("");

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!number.trim() || !code.trim()) return;
        router.push(certificateVerificationPath(number.trim().toUpperCase(), code.trim().toUpperCase()));
      }}
    >
      <Input
        label="Certificate number"
        name="certificate-number"
        placeholder="ARS-SPI-2026-000001"
        value={number}
        onChange={(e) => setNumber(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Input
        label="Verification code"
        name="verification-code"
        placeholder="20-character code printed on the certificate"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Button type="submit" disabled={!number.trim() || !code.trim()}>
        <Search className="h-4 w-4" /> Verify certificate
      </Button>
    </form>
  );
}
