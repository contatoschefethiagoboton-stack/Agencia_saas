import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import App from './App';
import { handOffFromLoginWindow } from './ui/oauthPopup';

const root = createRoot(document.getElementById('root')!);
if (handOffFromLoginWindow()) {
  // a janela de login das redes já entregou o resultado; se o navegador não deixar fechar sozinha, avisa
  root.render(
    <div className="center-page"><div className="card" style={{ maxWidth: 420, textAlign: 'center' }}>
      <h2>Pronto! Conexão concluída.</h2>
      <p className="card-sub" style={{ margin: 0 }}>Pode fechar esta janela e voltar para a plataforma.</p>
      <button className="btn btn-primary" onClick={() => window.close()}>Fechar janela</button>
    </div></div>);
} else {
  root.render(<StrictMode><App /></StrictMode>);
}
