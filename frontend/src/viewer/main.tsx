import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Viewer from './Viewer';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(<StrictMode><Viewer /></StrictMode>);
