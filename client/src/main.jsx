import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PhoneViewHost from './components/PhoneFrame';
import './styles.css';
import './student/student.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><PhoneViewHost><App/></PhoneViewHost></React.StrictMode>
);
