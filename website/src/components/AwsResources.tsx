import React, { useState, useEffect } from 'react';
import { formatTimestamp } from '../utils/dateUtils';
import {
  Header,
  Table,
  Box,
  SpaceBetween,
  Badge,
  TextFilter,
  Select,
  SelectProps,
  Button,
  Pagination
} from '@cloudscape-design/components';
import { apiRequest } from '../utils/api';

interface Resource {
  id: string;
  resource_type: string;
  resource_arn: string;
  resource_name: string;
  description: string;
  service: string;
  construct?: string;
  construct_id?: string;
  construct_name?: string;
  region: string;
  account_id: string;
  deployment: string;
  status: 'ACTIVE' | 'DELETED' | 'ERROR';
  created_at: string;
  updated_at: string;
}

const AwsResources: React.FC = () => {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [filteringText, setFilteringText] = useState('');
  const [selectedService, setSelectedService] = useState<SelectProps.Option>({ label: 'All Services', value: 'all' });
  const [selectedStatus, setSelectedStatus] = useState<SelectProps.Option>({ label: 'Active', value: 'ACTIVE' });
  const [selectedConstruct, setSelectedConstruct] = useState<SelectProps.Option>({ label: 'All Constructs', value: 'all' });
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pageSize] = useState(20);
  const [groupByConstruct, setGroupByConstruct] = useState(() => {
    const saved = localStorage.getItem('awsResourcesGrouped');
    return saved === 'true';
  });
  const [expandedConstructs, setExpandedConstructs] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchResources();
  }, []);

  const fetchResources = async () => {
    setLoading(true);
    try {
      const data = await apiRequest('/aws-resources');
      setResources(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch AWS resources:', { errorType: error.name });
      setResources([]);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ACTIVE': return 'green';
      case 'DELETED': return 'red';
      case 'ERROR': return 'red';
      default: return 'grey';
    }
  };

  const getConstructColor = (construct: string): "blue" | "grey" | "green" | "red" => {
    switch (construct) {
      case 'datastore': return 'blue';
      case 'dicom-service': return 'green';
      case 'hl7-service': return 'red';
      default: return 'grey';
    }
  };

  const services = Array.from(new Set(resources.map(r => r.service)));
  const serviceOptions = [
    { label: 'All Services', value: 'all' },
    ...services.map(s => ({ label: s, value: s }))
  ];

  const constructs = Array.from(new Set(resources.map(r => r.construct).filter(Boolean)));
  const constructOptions = [
    { label: 'All Constructs', value: 'all' },
    ...constructs.map(c => ({ label: c, value: c }))
  ];

  const statusOptions = [
    { label: 'All Status', value: 'all' },
    { label: 'Active', value: 'ACTIVE' },
    { label: 'Deleted', value: 'DELETED' },
    { label: 'Error', value: 'ERROR' }
  ];

  // Persist groupByConstruct preference
  useEffect(() => {
    localStorage.setItem('awsResourcesGrouped', String(groupByConstruct));
  }, [groupByConstruct]);

  // Auto-expand all constructs when grouping is enabled
  useEffect(() => {
    if (groupByConstruct && expandedConstructs.size === 0 && resources.length > 0) {
      // Compute group keys on the fly
      const groups = new Set<string>();
      resources.forEach(resource => {
        const constructType = resource.construct || 'uncategorized';
        const constructName = resource.construct_name || resource.construct_id || 'unknown';
        groups.add(`${constructType}:${constructName}`);
      });
      setExpandedConstructs(groups);
    }
  }, [groupByConstruct, resources, expandedConstructs.size]);

  const filteredResources = resources.filter(resource => {
    const matchesText = 
      resource.resource_name.toLowerCase().includes(filteringText.toLowerCase()) ||
      resource.resource_arn.toLowerCase().includes(filteringText.toLowerCase()) ||
      resource.description?.toLowerCase().includes(filteringText.toLowerCase());
    
    const matchesService = selectedService.value === 'all' || resource.service === selectedService.value;
    const matchesStatus = selectedStatus.value === 'all' || resource.status === selectedStatus.value;
    const matchesConstruct = selectedConstruct.value === 'all' || resource.construct === selectedConstruct.value;

    return matchesText && matchesService && matchesStatus && matchesConstruct;
  });

  // Group resources by construct instance (type + name)
  const groupedResources = groupByConstruct ? (() => {
    const groups: { [key: string]: Resource[] } = {};
    filteredResources.forEach(resource => {
      const constructType = resource.construct || 'uncategorized';
      const constructName = resource.construct_name || resource.construct_id || 'unknown';
      const groupKey = `${constructType}:${constructName}`;
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(resource);
    });
    return groups;
  })() : {};

  const displayItems = groupByConstruct ? 
    Object.entries(groupedResources).flatMap(([groupKey, items]) => {
      const [constructType, constructName] = groupKey.split(':');
      const constructRow = {
        isConstructHeader: true,
        construct: constructType,
        constructName: constructName,
        groupKey: groupKey,
        resourceCount: items.length
      };
      const resourceRows = expandedConstructs.has(groupKey) ? items.map(r => ({ ...r, isConstructHeader: false })) : [];
      return [constructRow, ...resourceRows];
    }) : filteredResources;

  const paginatedResources = displayItems.slice(
    (currentPageIndex - 1) * pageSize,
    currentPageIndex * pageSize
  );

  const toggleConstruct = (construct: string) => {
    const newExpanded = new Set(expandedConstructs);
    if (newExpanded.has(construct)) {
      newExpanded.delete(construct);
    } else {
      newExpanded.add(construct);
    }
    setExpandedConstructs(newExpanded);
  };

  const columnDefinitions = groupByConstruct ? [
    {
      id: 'name',
      header: 'Resource / Construct',
      cell: (item: any) => {
        if (item.isConstructHeader) {
          const displayName = `${item.construct.charAt(0).toUpperCase() + item.construct.slice(1)}: ${item.constructName}`;
          return (
            <Box>
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="icon"
                  iconName={expandedConstructs.has(item.groupKey) ? 'angle-down' : 'angle-right'}
                  onClick={() => toggleConstruct(item.groupKey)}
                />
                <Box fontWeight="bold">{displayName}</Box>
                <Badge>{item.resourceCount} resources</Badge>
              </SpaceBetween>
            </Box>
          );
        }
        return <Box padding={{ left: 'xxl' }}>{item.resource_name}</Box>;
      }
    },
    {
      id: 'service',
      header: 'Service',
      cell: (item: any) => item.isConstructHeader ? '' : item.service
    },
    {
      id: 'type',
      header: 'Type',
      cell: (item: any) => item.isConstructHeader ? '' : item.resource_type
    },
    {
      id: 'created',
      header: 'Created',
      cell: (item: any) => item.isConstructHeader ? '' : (item.created_at ? formatTimestamp(item.created_at) : '-')
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: any) => item.isConstructHeader ? '' : (
        <Badge color={getStatusColor(item.status)}>{item.status}</Badge>
      )
    }
  ] : [
    {
      id: 'service',
      header: 'Service',
      cell: (item: any) => item.service
    },
    {
      id: 'construct',
      header: 'Construct',
      cell: (item: any) => item.construct ? (
        <Badge color={getConstructColor(item.construct)}>{item.construct}</Badge>
      ) : '-'
    },
    {
      id: 'construct_id',
      header: 'Construct ID',
      cell: (item: any) => item.construct_id || '-'
    },
    {
      id: 'name',
      header: 'Resource Name',
      cell: (item: any) => item.resource_name,
      sortingField: 'resource_name'
    },
    {
      id: 'created',
      header: 'Created',
      cell: (item: any) => item.created_at ? formatTimestamp(item.created_at) : '-'
    },
    {
      id: 'type',
      header: 'Type',
      cell: (item: any) => item.resource_type
    },
    {
      id: 'description',
      header: 'Description',
      cell: (item: any) => item.description || '-'
    },
    {
      id: 'region',
      header: 'Region',
      cell: (item: any) => item.region || '-'
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: any) => <Badge color={getStatusColor(item.status)}>{item.status}</Badge>
    }
  ];

  return (
    <Table
      variant="full-page"
      stickyHeader={true}
      columnDefinitions={columnDefinitions}
      items={paginatedResources}
      loading={loading}
      loadingText="Loading resources..."
      sortingDisabled={false}
      empty={
        <Box textAlign="center" color="inherit">
          <b>No resources</b>
          <Box padding={{ bottom: 's' }} variant="p" color="inherit">
            No AWS resources found.
          </Box>
        </Box>
      }
      filter={
        <SpaceBetween direction="horizontal" size="xs">
          <TextFilter
            filteringText={filteringText}
            filteringPlaceholder="Search resources..."
            onChange={({ detail }) => setFilteringText(detail.filteringText)}
          />
          <Select
            selectedOption={selectedService}
            onChange={({ detail }) => setSelectedService(detail.selectedOption)}
            options={serviceOptions}
          />
          <Select
            selectedOption={selectedConstruct}
            onChange={({ detail }) => setSelectedConstruct(detail.selectedOption)}
            options={constructOptions}
          />
          <Select
            selectedOption={selectedStatus}
            onChange={({ detail }) => setSelectedStatus(detail.selectedOption)}
            options={statusOptions}
          />
        </SpaceBetween>
      }
      pagination={
        <Pagination
          currentPageIndex={currentPageIndex}
          pagesCount={Math.ceil(displayItems.length / pageSize)}
          onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
        />
      }
      header={
        <Header
          counter={`(${filteredResources.length})`}
          description="AWS resources dynamically created by the application"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                iconName={groupByConstruct ? 'view-horizontal' : 'view-vertical'}
                onClick={() => setGroupByConstruct(!groupByConstruct)}
              >
                {groupByConstruct ? 'Ungroup' : 'Group by Construct'}
              </Button>
              <Button
                iconName="refresh"
                onClick={fetchResources}
                loading={loading}
              >
                Refresh
              </Button>
            </SpaceBetween>
          }
        >
          AWS Resources
        </Header>
      }
    />
  );
};

export default AwsResources;
