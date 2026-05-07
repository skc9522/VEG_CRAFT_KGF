import { useState } from 'react';
import AdminLogin, { adminLogout } from './AdminLogin.jsx';
import OrdersBoard from './OrdersBoard.jsx';
import SettingsBoard from './SettingsBoard.jsx';

export default function App() {
  const [isAuth, setIsAuth] = useState(() => {
    try {
      return localStorage.getItem('admin_auth') === 'true';
    } catch {
      return false;
    }
  });
  const [tab, setTab] = useState('orders');

  if (!isAuth) {
    return <AdminLogin onSuccess={() => setIsAuth(true)} />;
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div>
          <h1 className="topbar__title">VEG CRAFT — Admin</h1>
          <p className="topbar__sub">Orders, open tabs, tables &amp; QR — live from Firestore</p>
        </div>
        <button type="button" className="btn btn--danger" onClick={adminLogout}>
          Log out
        </button>
      </header>

      <nav className="admin-tabs" aria-label="Admin sections">
        <button
          type="button"
          className={`admin-tab ${tab === 'orders' ? 'admin-tab--active' : ''}`}
          onClick={() => setTab('orders')}
        >
          Orders
        </button>
        <button
          type="button"
          className={`admin-tab ${tab === 'bills' ? 'admin-tab--active' : ''}`}
          onClick={() => setTab('bills')}
        >
          Bills
        </button>
        <button type="button" className={`admin-tab ${tab === 'settings' ? 'admin-tab--active' : ''}`} onClick={() => setTab('settings')}>
          Settings
        </button>
      </nav>

      {tab === 'orders' ? (
        <OrdersBoard />
      ) : tab === 'bills' ? (
        <OrdersBoard billingOnly />
      ) : (
        <SettingsBoard />
      )}
    </div>
  );
}
