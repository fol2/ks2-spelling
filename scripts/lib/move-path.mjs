import { cp, rename, rm } from 'node:fs/promises';

export async function movePath(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await cp(source, destination, { recursive: true });
    await rm(source, { recursive: true, force: true });
  }
}
