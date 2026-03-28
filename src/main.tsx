import './i18n';
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Auto dark mode based on system preference
const applyTheme = () => {
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
};

applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

createRoot(document.getElementById("root")!).render(<App />);
