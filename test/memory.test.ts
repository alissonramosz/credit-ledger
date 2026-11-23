import { MemoryStore } from '../src/index.js';
import { describeLedger } from './conformance.js';

describeLedger('MemoryStore', async () => ({ store: new MemoryStore() }));
