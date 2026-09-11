// POST /api/upload — pin a token logo to IPFS via Pinata.
//
// The create form uploads the chosen image here; we forward it to Pinata's pinFileToIPFS and return
// the public gateway URL + CID. PINATA_JWT lives in the repo-root .env (loaded by loadRepoRootEnv,
// the same loader the launch routes use). The JWT is SERVER-ONLY: it is never returned, logged, or
// echoed back to the client.

import { NextResponse } from "next/server";
import { loadRepoRootEnv } from "@/lib/server/env";

export const runtime = "nodejs"; // needs Node fetch with FormData streaming + the repo-root env loader
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const PINATA_ENDPOINT = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const GATEWAY = "https://gateway.pinata.cloud/ipfs"; // no PINATA_GATEWAY set; use the public gateway

export async function POST(req: Request) {
  loadRepoRootEnv();
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json({ error: "Image upload is not configured." }, { status: 500 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Send the image as multipart/form-data." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image file was provided." }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "The file must be an image." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "The image must be 5 MB or smaller." }, { status: 413 });
  }

  const body = new FormData();
  body.append("file", file, file.name || "logo");

  let res: Response;
  try {
    res = await fetch(PINATA_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` }, // do NOT log or return this header
      body,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the pinning service." }, { status: 502 });
  }

  if (!res.ok) {
    // Read the body only to know it failed; never surface it (it can echo request details).
    return NextResponse.json(
      { error: `Pinning failed (${res.status}).` },
      { status: res.status === 401 || res.status === 403 ? 502 : 502 },
    );
  }

  let data: { IpfsHash?: string };
  try {
    data = (await res.json()) as { IpfsHash?: string };
  } catch {
    return NextResponse.json({ error: "Pinning returned an unexpected response." }, { status: 502 });
  }

  const cid = data.IpfsHash;
  if (!cid) {
    return NextResponse.json({ error: "Pinning returned no CID." }, { status: 502 });
  }

  return NextResponse.json({ url: `${GATEWAY}/${cid}`, cid });
}
