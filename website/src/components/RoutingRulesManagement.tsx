import React, { useState, useEffect } from 'react';
import {
  Table, Header, Button, SpaceBetween, Box, StatusIndicator, Select, Alert, TextFilter, Modal
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import RoutingRuleModal from './RoutingRuleModal';
import { usePrivileges } from '../hooks/usePrivileges';

const RoutingRulesManagement: React.FC = () => {
  const { hasManagementAccess } = usePrivileges();
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [selectedRule, setSelectedRule] = useState<any>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<any>(null);
  const [interfaces, setInterfaces] = useState<any[]>([]);
  const [selectedInterface, setSelectedInterface] = useState<any>(null);
  const [filteringText, setFilteringText] = useState('');
  const [ruleToDelete, setRuleToDelete] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);

  const loadInterfaces = async () => {
    try {
      const response = await apiClient.getDicomInterfaces();
      const interfaceList = (response as any).data?.items || [];
      setInterfaces(interfaceList);
      // Auto-select first interface if available
      if (interfaceList.length > 0 && !selectedInterface) {
        setSelectedInterface({ label: interfaceList[0].interfaceName, value: interfaceList[0].id });
      }
    } catch (error) {
      console.error('Failed to load interfaces:', error.message);
    }
  };

  const loadRules = async () => {
    if (!selectedInterface) return;
    
    setLoading(true);
    try {
      const response = await apiClient.getRoutingRules(selectedInterface.value);
      setRules(response.data || []);
    } catch (error) {
      console.error('Failed to load routing rules:', error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInterfaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInterface]);
  const handleMovePriorityUp = async (ruleId: string) => {
    try {
      await apiClient.moveRulePriorityUp(ruleId);
      await loadRules();
    } catch (error: any) {
      console.error('Failed to move priority up:', error.message);
      alert(error.message || 'Failed to move priority up');
    }
  };

  const handleMovePriorityDown = async (ruleId: string) => {
    try {
      await apiClient.moveRulePriorityDown(ruleId);
      await loadRules();
    } catch (error: any) {
      console.error('Failed to move priority down:', error.message);
      alert(error.message || 'Failed to move priority down');
    }
  };

  const handleDelete = (ruleId: string) => {
    const rule = rules.find((r) => r.id === ruleId) || selectedRule || { id: ruleId };
    setRuleToDelete(rule);
  };

  const confirmDelete = async () => {
    if (!ruleToDelete) return;
    setDeleting(true);
    try {
      await apiClient.deleteRoutingRule(ruleToDelete.id);
      await loadRules();
      setRuleToDelete(null);
    } catch (error) {
      console.error('Failed to delete rule:', error.message);
    } finally {
      setDeleting(false);
    }
  };

  const handleCreate = () => {
    setEditingRule(null);
    setShowModal(true);
  };

  const handleEdit = (rule: any) => {
    setEditingRule(rule);
    setShowModal(true);
  };

  const formatConditions = (conditions: any) => {
    if (!conditions || !conditions.conditions || conditions.conditions.length === 0) {
      return 'All (no filters)';
    }
    
    const summary = conditions.conditions.slice(0, 2).map((c: any) => {
      if (c.conditions) return `(${c.logic} group)`;
      return `${c.dicomName}=${c.value}`;
    }).join(', ');
    
    return conditions.conditions.length > 2 ? `${summary}...` : summary;
  };

  // Filter rules based on search text
  const filteredRules = rules.filter(rule =>
    rule.name?.toLowerCase().includes(filteringText.toLowerCase()) ||
    rule.interfaceName?.toLowerCase().includes(filteringText.toLowerCase()) ||
    rule.datastoreName?.toLowerCase().includes(filteringText.toLowerCase())
  );

  return (
    <>
      <SpaceBetween size="l">
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Select
                selectedOption={selectedInterface}
                onChange={({ detail }) => setSelectedInterface(detail.selectedOption)}
                options={(interfaces || []).map(i => ({ label: i.interfaceName, value: i.id }))}
                placeholder="Select interface"
              />
              <Button iconName="refresh" onClick={() => { setIsManualRefresh(true); loadRules().finally(() => setIsManualRefresh(false)); }} loading={isManualRefresh && loading}>Refresh</Button>
              <Button variant="primary" onClick={handleCreate}>
                Create Rule
              </Button>
            </SpaceBetween>
          }
        >
        Routing Rules
      </Header>

      <Table
        header={
          <Header
            counter={`(${filteredRules.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => handleEdit(selectedRule)} disabled={!selectedRule}>Edit</Button>
                <Button onClick={() => selectedRule && handleDelete(selectedRule.id)} disabled={!selectedRule}>Delete</Button>
              </SpaceBetween>
            }
          />
        }
        filter={
          <TextFilter
            filteringText={filteringText}
            onChange={({ detail }) => setFilteringText(detail.filteringText)}
            filteringPlaceholder="Search routing rules..."
          />
        }
        loading={loading}
        selectedItems={selectedRule ? [selectedRule] : []}
        onSelectionChange={({ detail }) => setSelectedRule(detail.selectedItems[0])}
        selectionType="single"
        columnDefinitions={[
          {
            id: 'priority',
            header: 'Priority',
            cell: (item) => {
              const idx = filteredRules.indexOf(item);
              const isFirst = idx === 0;
              const isLast = idx === filteredRules.length - 1;
              const canEdit = hasManagementAccess('routingRules', 'canEdit');
              return (
                <SpaceBetween direction="horizontal" size="xxs">
                  <Button
                    iconName="caret-up-filled"
                    variant="inline-icon"
                    onClick={() => handleMovePriorityUp(item.id)}
                    disabled={!canEdit || isFirst}
                  />
                  <Button
                    iconName="caret-down-filled"
                    variant="inline-icon"
                    onClick={() => handleMovePriorityDown(item.id)}
                    disabled={!canEdit || isLast}
                  />
                </SpaceBetween>
              );
            },
            width: 80
          },
          {
            id: 'name',
            header: 'Rule Name',
            cell: (item) => item.name
          },
          {
            id: 'interface',
            header: 'Interface',
            cell: (item) => (
              <Box>
                <Box fontWeight="bold">{item.interfaceName || '-'}</Box>
                <Box fontSize="body-s" color="text-body-secondary">{item.interfaceId}</Box>
              </Box>
            )
          },
          {
            id: 'conditions',
            header: 'Conditions',
            cell: (item) => formatConditions(item.conditions)
          },
          {
            id: 'destination',
            header: 'Destination',
            cell: (item) => (
              <Box>
                <Box fontWeight="bold">{item.datastoreName || '-'}</Box>
                <Box fontSize="body-s" color="text-body-secondary">{item.action?.datastoreId || '-'}</Box>
              </Box>
            )
          },
          {
            id: 'status',
            header: 'Status',
            cell: (item) => (
              <StatusIndicator type={item.enabled ? 'success' : 'stopped'}>
                {item.enabled ? 'Enabled' : 'Disabled'}
              </StatusIndicator>
            )
          }
        ]}
        items={filteredRules}
        empty={
          <Box textAlign="center" color="inherit">
            <b>No routing rules</b>
            <Box variant="p" color="inherit">
              Create a rule to route DICOM data to datastores
            </Box>
          </Box>
        }
      />

      <RoutingRuleModal
        visible={showModal}
        onDismiss={() => setShowModal(false)}
        onSuccess={loadRules}
        rule={editingRule}
        defaultInterfaceId={selectedInterface?.value}
      />

      <Modal
        visible={!!ruleToDelete}
        onDismiss={() => setRuleToDelete(null)}
        header="Delete routing rule"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setRuleToDelete(null)}>Cancel</Button>
              <Button variant="primary" onClick={confirmDelete} loading={deleting}>Delete</Button>
            </SpaceBetween>
          </Box>
        }
      >
        Are you sure you want to delete this rule?
      </Modal>
    </SpaceBetween>
    </>
  );
};

export default RoutingRulesManagement;
