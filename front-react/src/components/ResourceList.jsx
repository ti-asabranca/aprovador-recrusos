import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import Notification from './Notification';
import 'bootstrap/dist/css/bootstrap.min.css';
import { FiCopy, } from 'react-icons/fi';
import { Modal, Button, Form } from 'react-bootstrap';
import { FaSort, FaSortUp, FaSortDown } from 'react-icons/fa';
import { FiInfo } from 'react-icons/fi';
import { utcToZonedTime, format } from 'date-fns-tz';
import {
  auth,
  googleProvider,
  githubProvider,
  signInWithPopup,
  signOut,
  db
} from '../components/firebase';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth"

const ResourceList = () => {
  const [resources, setResources] = useState([]);
  const [filterIntegrado, setFilterIntegrado] = useState('false');
  const [textFilter, setTextFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const timeZone = 'America/Sao_Paulo';
  const [notifications, setNotifications] = useState([]);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [copiedId] = useState(null);
  const [loadingResourceId, setLoadingResourceId] = useState(null);
  const [processedIds, setProcessedIds] = useState(new Set()); // NOVO: quem já processou
  const [showObsModal, setShowObsModal] = useState(false);
  const [selectedObservation, setSelectedObservation] = useState('');
  const [selectedResourceId, setSelectedResourceId] = useState(null);
  const [user, setUser] = useState(null);
  const [prEditable, setPrEditable] = useState(true);
  const [userProfile, setUserProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showLoginOptions, setShowLoginOptions] = useState(false);
  const [isLoginInProgress, setIsLoginInProgress] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [editingEmptyObs] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [newResource, setNewResource] = useState({
    recurso: '',
    ambiente: '',
    observacao: '',
    usuario: '',
    pr: '',
    mergeado: ''
  });
  const [sorting, setSorting] = useState({ col: null, dir: 'asc' });
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedResourceDetails, setSelectedResourceDetails] = useState([]);
  const [detailsLoading] = useState(false);
  const [selectedResourceName, setSelectedResourceName] = useState('');
  // utilitário clipboard
  const copyToClipboard = (text, id) => {
    const fullPath = getFullPath(text);

    if (navigator.clipboard) {
      navigator.clipboard.writeText(fullPath).catch(() => fallbackCopy(fullPath));
    } else {
      fallbackCopy(fullPath);
    }

    setProcessedIds(prev => new Set(prev).add(id));
  };

  const formatZonedDate = (dateStr, fmt = 'dd/MM/yyyy HH:mm:ss') => {
    return format(utcToZonedTime(dateStr, timeZone), fmt, { timeZone });
  };

  const addNotification = (message, type = 'info') => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, message, type }]);

    // Remove automaticamente após 5 segundos
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 5000);
  };

  const fetchResourceDetails = async (recurso, id) => {
    try {
      setLoadingResourceId(id);
      const parts = recurso.split('/');
      const fileName = parts[parts.length - 1];

      setSelectedResourceName(fileName); // 👈 Guarda o nome do recurso

      const response = await axios.get('http://192.168.0.21:7000/recursos-info', {
        params: { fonte: fileName }
      });

      setSelectedResourceDetails(response.data.data);
      setShowDetailsModal(true);
    } catch (error) {
      console.error('Erro ao buscar detalhes:', error);
      addNotification('Erro ao carregar detalhes do recurso', 'error');
    } finally {
      setLoadingResourceId(null);
    }
  };

  const fallbackCopy = (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  const updateField = async (id, field, value) => {
    try {
      await axios.put(`http://192.168.0.21:7000/update-resource/${id}`, { [field]: value });
      fetchResources();
    } catch (error) {
      console.error(`Erro ao atualizar ${field}:`, error);
      addNotification(`Erro ao atualizar ${field}`, 'error');
    }
  };

  const handleObservationClick = (resource) => {
    setSelectedResourceId(resource.id);
    setSelectedObservation(resource.observacao || '');
    setShowObsModal(true);
  };

  const getFullPath = (recurso) => {
    let basePath = 'C:/Repositorio/'; // Padrão fallback

    if (userProfile?.local) {
      basePath = userProfile.local.endsWith('/')
        ? userProfile.local
        : userProfile.local + '/';
    }

    return `${basePath}ProjetoAsa/${recurso}`.replace(/\\/g, '/');
  };

  const handleCreateResource = async () => {
    try {
      const { recurso, usuario } = newResource;

      // Validação dos campos obrigatórios
      if (!recurso || !usuario) {
        addNotification('Campos obrigatórios: recurso e usuário', 'error');
        return;
      }

      let finalPR = newResource.pr;

      // Lógica de auto-complete do PR
      if (!finalPR) {
        try {
          const response = await axios.get('http://192.168.0.21:7000/get-next-available-pr', {
            params: { recurso: recurso }
          });

          if (response.data.success) {
            finalPR = response.data.pr;
            setNewResource(prev => ({ ...prev, pr: finalPR }));
            setPrEditable(false); // Bloqueia edição do PR
            addNotification(`PR ${finalPR} atribuído automaticamente`, 'success');
          } else {
            throw new Error('Falha ao obter PR automático');
          }
        } catch (error) {
          addNotification(error.response?.data?.error || 'Erro ao buscar PR disponível', 'error');
          return;
        }
      }

      // Verificação final do PR
      if (!finalPR) {
        addNotification('Não foi possível determinar um PR válido', 'error');
        return;
      }

      // Dados completos para envio
      const resourceData = {
        ...newResource,
        pr: finalPR,
        mergeado: newResource.mergeado || new Date().toISOString()
      };

      // Chamada para API
      await axios.post('http://192.168.0.21:7000/recursos', resourceData);

      // Feedback e reset
      addNotification('Recurso criado com sucesso!', 'success');
      setShowModal(false);
      fetchResources();

      // Reset do estado do PR
      setPrEditable(true);

    } catch (error) {
      // Tratamento de erros específicos
      if (error.response?.data?.error?.includes('já existe')) {
        addNotification('Recurso duplicado: Utilize o PR sugerido ou edite o existente', 'warning');
      } else {
        addNotification(error.response?.data?.error || 'Erro ao criar recurso', 'error');
      }
      console.error('Erro detalhado:', error);
    }
  };

  const handleSync = async () => {
    setSyncLoading(true);
    setSyncMessage('');
    try {
      const response = await axios.get('http://192.168.0.21:7000/merged-prs-files');
      if (response.data.success) {
        addNotification('✅ Dados sincronizados com sucesso!', 'success');
        fetchResources();
      } else {
        throw new Error(response.data.message || 'Erro na sincronização');
      }
    } catch (error) {
      setSyncMessage(`❌ Erro: ${error.response?.data?.error || error.message}`);
    } finally {
      setSyncLoading(false);
    }
  };

  const fetchResources = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await axios.get(`http://192.168.0.21:7000/recursos?integrado=${filterIntegrado}`);
      setResources(resp.data.data);
      setSelectedIds(new Set());
      setProcessedIds(new Set()); // limpa processados ao recarregar
    } catch (err) {
      console.error(err);
      addNotification('Erro ao carregar dados', 'error');
    }
    setLoading(false);
  }, [filterIntegrado]);

  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  useEffect(() => {
    if (showModal && userProfile?.name) {
      setNewResource(prev => ({
        ...prev,
        usuario: userProfile.name
      }));
    }
  }, [showModal, userProfile]);

  useEffect(() => {
    if (showModal) {
      setPrEditable(true);
      setNewResource(prev => ({ ...prev, pr: '' }));
    }
  }, [showModal]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setAuthLoading(true);

      if (user) {
        try {
          const userRef = doc(db, "users", user.uid);

          // Primeiro tenta buscar do cache local
          const localDoc = await getDoc(userRef, { source: 'cache' });

          if (!localDoc.exists()) {
            // Se não existir local, tenta buscar do servidor
            const serverDoc = await getDoc(userRef, { source: 'server' });

            if (!serverDoc.exists()) {
              await setDoc(userRef, {
                name: user.displayName,
                age: "",
                local: "",
                photo: user.photoURL,
                email: user.email
              });
            }
          }

          // Atualiza estados
          const finalDoc = await getDoc(userRef);
          setUser(user);
          setUserProfile(finalDoc.data());

          // Salva no localStorage
          localStorage.setItem('user', JSON.stringify({
            uid: user.uid,
            ...finalDoc.data()
          }));

        } catch (error) {
          console.log("Modo offline - usando dados locais:", error);
          const cachedUser = localStorage.getItem('user');
          if (cachedUser) {
            setUserProfile(JSON.parse(cachedUser));
            setUser({ uid: JSON.parse(cachedUser).uid }); // Mantém estado mínimo do usuário
          }
        }

      } else {
        setUser(null);
        setUserProfile(null);
        localStorage.removeItem('user');
      }

      setAuthLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const toggleStatus = async (id) => {
    try {
      await axios.put(`http://192.168.0.21:7000/toggle-status/${id}`);
      fetchResources();
    } catch (error) {
      console.error('Erro ao alterar status:', error);
      addNotification('Erro ao atualizar status', 'error');
    }
  };

  const handleBulkUpdate = async () => {
    for (let id of selectedIds) {
      await axios.put(`http://192.168.0.21:7000/toggle-status/${id}`);
    }
    fetchResources();
  };

  const handleSort = (col) => {
    setSorting(prev => ({
      col,
      dir: prev.col === col && prev.dir === 'asc' ? 'desc' : 'asc'
    }));
  };

  const displayed = useMemo(() => {
    let arr = resources;
    if (textFilter) {
      const tf = textFilter.toLowerCase();
      arr = arr.filter(r =>
        Object.values(r).some(val =>
          typeof val === 'string' && val.toLowerCase().includes(tf)
        )
      );
    }
    if (sorting.col) {
      arr = [...arr].sort((a, b) => {
        const va = a[sorting.col] ?? '';
        const vb = b[sorting.col] ?? '';
        if (typeof va === 'number') {
          return sorting.dir === 'asc' ? va - vb : vb - va;
        }
        return sorting.dir === 'asc'
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
    }
    return arr;
  }, [resources, textFilter, sorting]);

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === displayed.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(displayed.map(r => r.id)));
    }
  };

  const handleLogin = async (providerType) => {
    // Bloqueia múltiplos cliques durante o processo
    if (isLoginInProgress) return;
    setIsLoginInProgress(true);
    setShowLoginOptions(false);

    try {
      const provider = providerType === 'github' ? githubProvider : googleProvider;
      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      try {
        const userRef = doc(db, "users", user.uid);
        const docSnap = await getDoc(userRef, { source: 'server' });

        // Cria documento se não existir
        if (!docSnap.exists()) {
          await setDoc(userRef, {
            name: user.displayName || 'Usuário sem nome',
            age: "",
            local: "",
            photo: user.photoURL || 'https://cdn-icons-png.flaticon.com/512/847/847969.png',
            email: user.email || '',
            lastLogin: new Date().toISOString()
          });
        }

        // Atualiza último login mesmo se o usuário já existir
        await updateDoc(userRef, {
          lastLogin: new Date().toISOString()
        });

        // Busca dados atualizados
        const finalDoc = await getDoc(userRef);

        // Atualiza estados
        setUser(user);
        setUserProfile(finalDoc.data());

        // Persistência offline
        localStorage.setItem('user', JSON.stringify({
          uid: user.uid,
          ...finalDoc.data()
        }));

      } catch (serverError) {
        console.error("Erro no Firestore:", serverError);

        // Fallback para dados locais
        const cachedUser = localStorage.getItem('user');
        if (cachedUser) {
          addNotification('Modo offline - usando dados locais', 'error');
          setUserProfile(JSON.parse(cachedUser));
          setUser({ uid: JSON.parse(cachedUser).uid });
        }
      }

    } catch (error) {
      console.error("Erro na autenticação:", error);

      // Tratamento específico de erros do Firebase
      switch (error.code) {
        case 'auth/popup-closed-by-user':
        case 'auth/cancelled-popup-request':
          // Não exibe alerta para fechamento intencional
          break;

        case 'auth/account-exists-with-different-credential':
          addNotification('Este e-mail já está cadastrado com outro provedor!', 'error');
          break;

        case 'auth/network-request-failed':
          addNotification('Erro de conexão. Verifique sua internet!', 'error');
          break;

        case 'auth/too-many-requests':
          addNotification('Muitas tentativas. Tente novamente mais tarde!', 'error');
          break;

        default:
          // Tratamento genérico para outros erros
          if (error.message.includes('internet')) {
            const cachedUser = localStorage.getItem('user');
            if (cachedUser) {
              addNotification('Modo offline - dados locais carregados', 'error');
              setUserProfile(JSON.parse(cachedUser));
            }
          } else {
            addNotification(`Erro inesperado: ${error.message}`, 'error');
          }
      }

    } finally {
      // Libera o estado de loading independente do resultado
      setIsLoginInProgress(false);
      setShowLoginOptions(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setUserProfile(null);
    } catch (error) {
      console.error("Erro no logout:", error);
    }
  };

  const handleUpdateProfile = async () => {
    try {
      const userRef = doc(db, "users", user.uid);
      await updateDoc(userRef, userProfile);
      setShowProfileModal(false);
    } catch (error) {
      console.error("Erro ao atualizar perfil:", error);
      addNotification("Erro ao salvar alterações!", 'error');
    }
  };

  return (
    <div className="mx-auto mt-5" style={{ width: '98%' }}>
      <div className="card shadow">
        <div className="card-header bg-primary text-white d-flex justify-content-between align-items-center">
          <h3>Gerenciador de Recursos</h3>
          <div className="d-flex gap-2 align-items-center">
            {authLoading ? (
              <div className="spinner-border spinner-border-sm text-light" />
            ) : user ? (
              <div className="d-flex align-items-center gap-2">
                <img
                  src={userProfile?.photo}
                  alt="Avatar"
                  className="rounded-circle"
                  style={{ width: '40px', height: '40px', cursor: 'pointer' }}
                  onClick={() => setShowProfileModal(true)}
                />
                <div>
                  <div>{userProfile?.name}</div>
                </div>
                <Button variant="danger" onClick={handleLogout} className="ms-2">
                  Sair
                </Button>
              </div>
            ) : (
              <div className="position-relative">
                <Button
                  variant="light"
                  onClick={() => setShowLoginOptions(!showLoginOptions)}
                  disabled={isLoginInProgress}
                >
                  {isLoginInProgress ? (
                    <div className="spinner-border spinner-border-sm" />
                  ) : (
                    '🔑 Logar'
                  )}
                </Button>

                {showLoginOptions && (
                  <div className="position-absolute top-100 end-0 mt-2 shadow rounded bg-white login-dropdown">
                    <div className="d-flex flex-column p-2" style={{ minWidth: '200px' }}>
                      <button
                        onClick={() => handleLogin('google')}
                        className="btn btn-light mb-2 d-flex align-items-center gap-2"
                      >
                        <img src="https://img.icons8.com/color/24/google-logo.png" alt="Google" />
                        Continuar com Google
                      </button>

                      <button
                        onClick={() => handleLogin('github')}
                        className="btn btn-dark d-flex align-items-center gap-2"
                      >
                        <img src="https://img.icons8.com/ios-filled/24/ffffff/github.png" alt="GitHub" />
                        Continuar com GitHub
                      </button>
                    </div>
                  </div>
                )}
              </div>

            )}
            <Button variant="success" onClick={() => setShowModal(true)}>➕ Novo</Button>
            <button className="btn btn-warning" onClick={handleSync} disabled={syncLoading}>
              {syncLoading ? 'Sincronizando...' : 'Sincronizar PRs'}
            </button>
          </div>
        </div>

        <div className="card-body">
          {syncMessage && (
            <div className={`alert ${syncMessage.includes('✅') ? 'alert-success' : 'alert-danger'}`}>
              {syncMessage}
            </div>
          )}

          <div className="row mb-3">
            <div className="col-md-2">
              <select
                className="form-select"
                value={filterIntegrado}
                onChange={e => setFilterIntegrado(e.target.value)}
              >
                <option value="false">Não Integrados</option>
                <option value="true">Integrados</option>
              </select>
            </div>
            <div className="col-md-4">
              <input
                type="text"
                className="form-control"
                placeholder="Filtro texto em todas as colunas..."
                value={textFilter}
                onChange={e => setTextFilter(e.target.value)}
              />
            </div>
            {selectedIds.size > 0 && (
              <div className="col-md-2">
                <button
                  className="btn btn-success"
                  onClick={handleBulkUpdate}
                >
                  Alterar todos
                </button>
              </div>
            )}
          </div>

          {loading ? (
            <div className="text-center"><div className="spinner-border" role="status" /></div>
          ) : (
            <div className="table-responsive">
              <table className="table table-striped">
                <thead>
                  <tr>
                    <th>
                      <Form.Check
                        type="checkbox"
                        checked={selectedIds.size === displayed.length && displayed.length > 0}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    {[
                      { id: 'recurso', label: 'Recurso' },
                      { id: 'ambiente', label: 'Ambiente' },
                      { id: 'observacao', label: 'Observação' },
                      { id: 'pr', label: 'PR' },
                      { id: 'usuario', label: 'Usuário' },
                      { id: 'mergeado', label: 'Mergeado' },
                      { id: 'integrado', label: 'Status' }
                    ].map(col => (
                      <th
                        key={col.id}
                        onClick={() => handleSort(col.id)}
                        style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        <div className="d-flex align-items-center gap-1">
                          {col.label}
                          <span style={{
                            backgroundColor: "white",
                            borderRadius: '3px',
                            padding: '2px',
                            display: 'inline-flex',
                            alignItems: 'center'
                          }}>
                            {sorting.col === col.id ? (
                              sorting.dir === 'asc' ? (
                                <FaSortUp color='#0d6efd' />
                              ) : (
                                <FaSortDown color='#0d6efd' />
                              )
                            ) : (
                              <FaSort color='#0d6efd' />
                            )}
                          </span>
                        </div>
                      </th>
                    ))}
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map(r => {
                    const parts = r.recurso.split('/');
                    const fileName = parts[parts.length - 1];
                    const isProcessed = processedIds.has(r.id);
                    return (
                      <tr key={r.id} style={{ backgroundColor: isProcessed ? '#e0ffe0' : 'inherit' }}>
                        <td>
                          <Form.Check
                            type="checkbox"
                            checked={selectedIds.has(r.id)}
                            onChange={() => toggleSelect(r.id)}
                          />
                        </td>
                        <td>
                          <div className="recurso-flex">
                            <a
                              href={`vscode://file/${userProfile?.local || 'C:/Repositorio/'}ProjetoAsa/${r.recurso}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ textDecoration: 'none', flexGrow: 1, fontWeight: isProcessed ? 'bold' : 'normal' }}
                              onClick={() => setProcessedIds(prev => new Set(prev).add(r.id))}
                            >
                              {fileName}
                            </a>
                            <div className="d-flex align-items-center gap-1">
                              <button
                                className="btn btn-link p-0"
                                onClick={() => copyToClipboard(r.recurso, r.id)}
                              >
                                <FiCopy />
                                {copiedId === r.id && <span className="ms-1 text-success">Copiado!</span>}
                              </button>
                              <button
                                className="btn btn-link p-0 ms-2"
                                onClick={() => {
                                  fetchResourceDetails(r.recurso, r.id);
                                }}
                                title="Ver detalhes"
                                disabled={loadingResourceId === r.id}
                              >
                                {loadingResourceId === r.id ? (
                                  <div className="spinner-border spinner-border-sm text-primary" />
                                ) : (
                                  <FiInfo />
                                )}
                              </button>
                            </div>
                          </div>
                        </td>

                        <td>
                          <input
                            type="text"
                            className="form-control form-control-sm"
                            defaultValue={r.ambiente}
                            onBlur={e => updateField(r.id, 'ambiente', e.target.value)}
                          />
                        </td>
                        <td
                          style={{ cursor: 'pointer', fontStyle: isProcessed ? 'italic' : 'normal' }}
                          onClick={() => {
                            handleObservationClick(r);
                            setProcessedIds(prev => new Set(prev).add(r.id));
                          }}
                        >
                          {r.observacao || 'Clique para adicionar'}
                        </td>
                        <td>#{r.pr}</td>
                        <td>{r.usuario}</td>
                        <td>{new Date(r.mergeado).toLocaleString()}</td>
                        <td>{r.integrado ? '✅' : '❌'}</td>
                        <td>
                          <button className="btn btn-primary btn-sm" onClick={() => toggleStatus(r.id)}>
                            Alterar Status
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <Modal show={showObsModal} onHide={() => setShowObsModal(false)} >
        <Modal.Header closeButton>
          <Modal.Title>{editingEmptyObs ? 'Adicionar Observação' : 'Observação'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form.Control
            as="textarea"
            rows={4}
            autoFocus
            value={selectedObservation}
            onChange={e => setSelectedObservation(e.target.value)}
            placeholder="Digite a observação"
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowObsModal(false)}>Cancelar</Button>
          <Button variant="primary" onClick={async () => {
            await updateField(selectedResourceId, 'observacao', selectedObservation);
            setShowObsModal(false);
          }}>Salvar</Button>
        </Modal.Footer>
      </Modal>

      <Modal show={showModal} onHide={() => setShowModal(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Adicionar Novo Recurso</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Form.Group className="mb-2">
              <Form.Label>Recurso*</Form.Label>
              <Form.Control
                type="text"
                value={newResource.recurso}
                onChange={e => setNewResource({ ...newResource, recurso: e.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-2">
              <Form.Label>Ambiente</Form.Label>
              <Form.Control
                type="text"
                value={newResource.ambiente}
                onChange={e => setNewResource({ ...newResource, ambiente: e.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-2">
              <Form.Label>Observação</Form.Label>
              <Form.Control
                as="textarea"
                rows={2}
                value={newResource.observacao}
                onChange={e => setNewResource({ ...newResource, observacao: e.target.value })}
              />
            </Form.Group>
            <Form.Group className="mb-2">
              <Form.Label>Usuário*</Form.Label>
              <Form.Control
                type="text"
                value={newResource.usuario}
                onChange={e => setNewResource({ ...newResource, usuario: e.target.value })}
                placeholder="Usuário será preenchido automaticamente"
                readOnly={!!userProfile?.name} // Opcional: bloquear edição se logado
              />
              {!userProfile?.name && (
                <Form.Text className="text-danger">
                  Faça login para preencher automaticamente
                </Form.Text>
              )}
            </Form.Group>
            <Form.Group className="mb-2">
              <Form.Label>PR</Form.Label>
              <Form.Control
                type="number"
                value={newResource.pr || ''}
                onChange={e => setNewResource({ ...newResource, pr: e.target.value })}
                readOnly={!prEditable}
                placeholder="Preenchimento automático"
              />
              <Form.Text className="text-muted">
                Será automaticamente gerado se deixado em branco
              </Form.Text>
            </Form.Group>
            <Form.Group className="mb-2">
              <Form.Label>Mergeado</Form.Label>
              <Form.Control
                type="datetime-local"
                value={newResource.mergeado}
                onChange={e => setNewResource({ ...newResource, mergeado: e.target.value })}
              />
            </Form.Group>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowModal(false)}>Cancelar</Button>
          <Button variant="primary" onClick={handleCreateResource}>Salvar</Button>
        </Modal.Footer>
      </Modal>
      <Modal show={showProfileModal} onHide={() => setShowProfileModal(false)}>
        <Modal.Header closeButton>
          <Modal.Title>Editar Perfil</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form>
            <Form.Group className="mb-3">
              <Form.Label>Nome</Form.Label>
              <Form.Control
                value={userProfile?.name || ''}
                onChange={(e) => setUserProfile(prev => ({ ...prev, name: e.target.value }))}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>Idade</Form.Label>
              <Form.Control
                type="number"
                value={userProfile?.age || ''}
                onChange={(e) => setUserProfile(prev => ({ ...prev, age: e.target.value }))}
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Label>
                Caminho Base (Ex: C:/Repositorio/)
                <small className="text-muted"> - Deve terminar com barra (/)</small>
              </Form.Label>
              <Form.Control
                value={userProfile?.local || ''}
                onChange={(e) => {
                  let value = e.target.value;
                  // Garante que termina com barra
                  if (value && !value.endsWith('/')) value += '/';
                  setUserProfile(prev => ({ ...prev, local: value }))
                }}
                placeholder="Digite o caminho completo até a pasta ProjetoAsa"
              />
            </Form.Group>
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowProfileModal(false)}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleUpdateProfile}>
            Salvar Alterações
          </Button>
        </Modal.Footer>
      </Modal>
      <Modal
        show={showDetailsModal}
        onHide={() => {
          setShowDetailsModal(false);
          setSelectedResourceName('');
        }}
        size="lg"
        className="resource-details-modal"
        backdrop="static"
      >
        <Modal.Header closeButton className="bg-primary text-white">
          <Modal.Title>
            📄 Detalhes do Recurso - {selectedResourceName}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {detailsLoading ? (
            <div className="text-center">
              <div className="spinner-border" role="status" />
              <p className="mt-2">Carregando detalhes...</p>
            </div>
          ) : (
            <div className="table-responsive">
              <table className="table table-hover table-bordered">
                <thead className="table-dark">
                  <tr>
                    <th>Ambiente</th>
                    <th>Data do Fonte</th>
                    <th>Hora do Fonte</th>
                    <th>Verificado</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedResourceDetails.map((detail) => (
                    <tr key={detail.id}>
                      <td>{detail.ambiente_rpo.trim().toUpperCase()}</td>
                      <td>{formatZonedDate(detail.data_fonte_rpo, 'dd/MM/yyyy')}</td>
                      <td>{formatZonedDate(detail.hora_fonte_rpo, 'HH:mm:ss')}</td>
                      <td>{formatZonedDate(detail.data_atualizacao)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selectedResourceDetails.length === 0 && (
                <div className="alert alert-info mb-0">Nenhum detalhe encontrado para este recurso</div>
              )}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setShowDetailsModal(false)}>
            Fechar
          </Button>
        </Modal.Footer>
      </Modal>
      {notifications.map(notification => (
        <Notification
          key={notification.id}
          message={notification.message}
          type={notification.type}
          onClose={() => setNotifications(prev => prev.filter(n => n.id !== notification.id))}
        />
      ))}
    </div>
  );
};

export default ResourceList;
