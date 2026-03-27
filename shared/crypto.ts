import nacl from "tweetnacl";

// Convert hex string to Uint8Array
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// Convert Uint8Array to hex string
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Generate a random 32-byte secret key as hex string
export function generateSecretKey(): string {
  return bytesToHex(nacl.randomBytes(32));
}

// Encrypt plaintext with secret key. Returns base64 string (nonce + ciphertext).
export function encrypt(plaintext: string, keyHex: string): string {
  const key = hexToBytes(keyHex);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);
  const encrypted = nacl.secretbox(messageBytes, nonce, key);
  if (!encrypted) throw new Error("Encryption failed");

  // Combine nonce + ciphertext
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);

  // Return as base64
  return btoa(String.fromCharCode(...combined));
}

// Decrypt base64 string (nonce + ciphertext) with secret key. Returns plaintext.
export function decrypt(encoded: string, keyHex: string): string {
  const key = hexToBytes(keyHex);
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));

  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = combined.slice(nacl.secretbox.nonceLength);

  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) throw new Error("Decryption failed — wrong key or corrupted message");

  return new TextDecoder().decode(decrypted);
}

// Parse invite code "room_id:secret_key" into parts
export function parseInviteCode(code: string): { roomId: string; secretKey: string } {
  const colonIndex = code.indexOf(":");
  if (colonIndex === -1 || code.substring(colonIndex + 1).length === 0) {
    throw new Error("Invalid invite code — must include secret key (format: room_id:secret_key)");
  }
  return {
    roomId: code.substring(0, colonIndex),
    secretKey: code.substring(colonIndex + 1),
  };
}

// SHA-256 hash of the secret key (hex string → hex hash)
export async function hashKey(keyHex: string): Promise<string> {
  const data = new TextEncoder().encode(keyHex);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}
