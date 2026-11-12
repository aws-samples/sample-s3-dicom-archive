import React, { useState, useEffect } from 'react';
import {
  FormField,
  Input,
  Select,
  Autosuggest,
  DatePicker,
  SpaceBetween,
  Button,
  Box
} from '@cloudscape-design/components';
import { DicomTag, getOperatorsForVr, getVrType, VR_TYPES } from '../../constants/dicomTags';
import { apiClient } from '../../services/apiClient';

interface Condition {
  attributeName: string;
  operator: string;
  value: string;
  valueEnd?: string;
  attributeVr?: string;
  logicOperator: string;
  isExclusion: boolean;
}

interface ConditionEditorProps {
  condition: Condition;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
  showLogicOperator: boolean;
}

const VR_OPTIONS = [
  { label: 'Date (DA)', value: 'DA' },
  { label: 'Date Time (DT)', value: 'DT' },
  { label: 'Time (TM)', value: 'TM' },
  { label: 'Integer String (IS)', value: 'IS' },
  { label: 'Decimal String (DS)', value: 'DS' },
  { label: 'Unsigned Short (US)', value: 'US' },
  { label: 'Unsigned Long (UL)', value: 'UL' },
  { label: 'Signed Short (SS)', value: 'SS' },
  { label: 'Signed Long (SL)', value: 'SL' },
  { label: 'Float (FL)', value: 'FL' },
  { label: 'Double (FD)', value: 'FD' },
  { label: 'Long String (LO)', value: 'LO' },
  { label: 'Short String (SH)', value: 'SH' },
  { label: 'Person Name (PN)', value: 'PN' },
  { label: 'Code String (CS)', value: 'CS' },
  { label: 'Short Text (ST)', value: 'ST' },
  { label: 'Long Text (LT)', value: 'LT' },
  { label: 'Unlimited Text (UT)', value: 'UT' }
];

const LOGIC_OPERATORS = [
  { label: 'AND', value: 'AND' },
  { label: 'OR', value: 'OR' }
];

export const ConditionEditor: React.FC<ConditionEditorProps> = ({
  condition,
  onChange,
  onRemove,
  showLogicOperator
}) => {
  const [isCustomAttribute, setIsCustomAttribute] = useState(false);
  const [attributeOptions, setAttributeOptions] = useState<any[]>([]);
  const [dicomTags, setDicomTags] = useState<DicomTag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDicomTags();
  }, []);

  const loadDicomTags = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get('/dicom-tags');
      if (response.success && response.data) {
        const tags = response.data.dicom_attributes || response.data;
        setDicomTags(tags);
        const options = tags.map((tag: DicomTag) => ({
          value: tag.keyword,
          label: `${tag.name} (${tag.tag})`,
          tags: [tag.vr],
          vr: tag.vr
        }));
        options.push({ value: '__CUSTOM__', label: 'Custom Attribute...', tags: ['CUSTOM'], vr: '' });
        setAttributeOptions(options);
      }
    } catch (err) {
      console.error('Failed to load DICOM tags:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Only treat the field as a CUSTOM (free-text tag) attribute when it was
    // explicitly chosen via the "Custom Attribute..." option, or when an
    // already-saved rule loads a value that is a raw DICOM tag (e.g. "0010,0010"
    // / "00100010") rather than a known keyword. Do NOT flip to custom mode just
    // because the current text is a PARTIAL, not-yet-matching keyword — that is
    // the user typing to filter the Autosuggest, and unmounting it mid-keystroke
    // is what made the dropdown close on every character.
    const name = condition.attributeName;
    const looksLikeRawTag = /^[0-9A-Fa-f]{4},?[0-9A-Fa-f]{4}$/.test(name);
    const isCustom = name === '__CUSTOM__' || (name !== '' && looksLikeRawTag);
    setIsCustomAttribute(isCustom);
  }, [condition.attributeName, dicomTags]);

  const handleAttributeChange = (detail: any) => {
    const value = detail.value;
    if (value === '__CUSTOM__') {
      setIsCustomAttribute(true);
      onChange({ ...condition, attributeName: '', attributeVr: 'LO', operator: 'EQUALS', value: '', valueEnd: '' });
      return;
    }
    const tag = dicomTags.find(t => t.keyword === value);
    if (tag) {
      // A full match: apply the attribute + its VR-driven operator defaults.
      const operators = getOperatorsForVr(tag.vr);
      onChange({
        ...condition,
        attributeName: value,
        attributeVr: tag.vr,
        operator: operators[0].value,
        value: '',
        valueEnd: ''
      });
    } else {
      // Partial / free typing: ALWAYS propagate the raw value so the controlled
      // Autosuggest reflects each keystroke (otherwise the field looks frozen and
      // cannot be typed into to filter the options).
      onChange({ ...condition, attributeName: value });
    }
  };

  const validateTagFormat = (value: string): string | null => {
    if (/^[0-9A-Fa-f]{4},[0-9A-Fa-f]{4}$/.test(value)) {
      return null;
    }
    if (/^[0-9A-Fa-f]{8}$/.test(value)) {
      return null;
    }
    if (value.length > 0 && /[0-9A-Fa-f,]/.test(value)) {
      return 'Tag format should be ####,#### or ########';
    }
    return null;
  };

  const currentVr = condition.attributeVr || 'LO';
  const vrType = getVrType(currentVr);
  const operators = getOperatorsForVr(currentVr);
  const isBetween = condition.operator === 'BETWEEN';

  return (
    <SpaceBetween size="xs">
      <Box>
        <SpaceBetween direction="horizontal" size="xs">
          {showLogicOperator && (
            <Select
              selectedOption={LOGIC_OPERATORS.find(o => o.value === condition.logicOperator) || LOGIC_OPERATORS[0]}
              onChange={({ detail }) => onChange({ ...condition, logicOperator: detail.selectedOption.value! })}
              options={LOGIC_OPERATORS}
            />
          )}
          
          {!isCustomAttribute ? (
            <Autosuggest
              value={condition.attributeName}
              onChange={({ detail }) => handleAttributeChange(detail)}
              options={attributeOptions}
              placeholder="Select DICOM attribute"
              filteringType="auto"
              enteredTextLabel={value => `Use: "${value}"`}
              statusType={loading ? 'loading' : 'finished'}
            />
          ) : (
            <SpaceBetween direction="horizontal" size="xs">
              <Input
                value={condition.attributeName}
                onChange={({ detail }) => {
                  const error = validateTagFormat(detail.value);
                  onChange({ ...condition, attributeName: detail.value });
                }}
                placeholder="Tag (e.g., 0010,0010) or Name"
              />
              <Select
                selectedOption={VR_OPTIONS.find(o => o.value === currentVr) || VR_OPTIONS[0]}
                onChange={({ detail }) => {
                  const newVr = detail.selectedOption.value!;
                  const newOperators = getOperatorsForVr(newVr);
                  onChange({ 
                    ...condition, 
                    attributeVr: newVr,
                    operator: newOperators[0].value,
                    value: '',
                    valueEnd: ''
                  });
                }}
                options={VR_OPTIONS}
                placeholder="VR Type"
              />
              <Button onClick={() => {
                setIsCustomAttribute(false);
                onChange({ ...condition, attributeName: '', attributeVr: '', operator: 'EQUALS', value: '', valueEnd: '' });
              }}>
                Cancel
              </Button>
            </SpaceBetween>
          )}
          
          <Select
            selectedOption={operators.find(o => o.value === condition.operator) || operators[0]}
            onChange={({ detail }) => onChange({ ...condition, operator: detail.selectedOption.value!, value: '', valueEnd: '' })}
            options={operators}
          />
          
          {vrType === 'DATE' ? (
            <>
              <DatePicker
                value={condition.value}
                onChange={({ detail }) => onChange({ ...condition, value: detail.value })}
                placeholder="YYYY-MM-DD"
              />
              {isBetween && (
                <>
                  <Box variant="span">to</Box>
                  <DatePicker
                    value={condition.valueEnd || ''}
                    onChange={({ detail }) => onChange({ ...condition, valueEnd: detail.value })}
                    placeholder="YYYY-MM-DD"
                  />
                </>
              )}
            </>
          ) : vrType === 'NUMERIC' ? (
            <>
              <Input
                type="number"
                value={condition.value}
                onChange={({ detail }) => onChange({ ...condition, value: detail.value })}
                placeholder="Value"
              />
              {isBetween && (
                <>
                  <Box variant="span">to</Box>
                  <Input
                    type="number"
                    value={condition.valueEnd || ''}
                    onChange={({ detail }) => onChange({ ...condition, valueEnd: detail.value })}
                    placeholder="Value"
                  />
                </>
              )}
            </>
          ) : (
            <Input
              value={condition.value}
              onChange={({ detail }) => onChange({ ...condition, value: detail.value })}
              placeholder={condition.operator === 'IN_LIST' ? 'Value1,Value2,Value3' : 'Value'}
            />
          )}
          
          <Button onClick={onRemove} iconName="remove" variant="icon" />
        </SpaceBetween>
      </Box>
    </SpaceBetween>
  );
};
