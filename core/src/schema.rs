/// Parse MySQL `COLUMN_TYPE` values like `enum('a','b')` or `enum('a\'quote')`.
pub fn parse_mysql_enum_type(column_type: &str) -> Option<Vec<String>> {
    let trimmed = column_type.trim();
    let lower = trimmed.to_lowercase();
    if !lower.starts_with("enum(") {
        return None;
    }

    let start = trimmed.find('(')?;
    let end = trimmed.rfind(')')?;
    if end <= start {
        return None;
    }

    let inner = &trimmed[start + 1..end];
    let mut values = Vec::new();
    let mut chars = inner.chars().peekable();

    while chars.peek().is_some() {
        while matches!(chars.peek(), Some(' ' | ',' | '\t')) {
            chars.next();
        }
        if chars.peek() != Some(&'\'') {
            break;
        }
        chars.next();

        let mut value = String::new();
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    value.push('\'');
                } else {
                    break;
                }
            } else {
                value.push(c);
            }
        }
        values.push(value);
    }

    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

#[cfg(test)]
mod tests {
    use super::parse_mysql_enum_type;

    #[test]
    fn parses_mysql_enum_literals() {
        assert_eq!(
            parse_mysql_enum_type("enum('pending','active','done')"),
            Some(vec![
                "pending".to_string(),
                "active".to_string(),
                "done".to_string(),
            ])
        );
    }

    #[test]
    fn parses_escaped_quotes() {
        assert_eq!(
            parse_mysql_enum_type("enum('it''s','ok')"),
            Some(vec!["it's".to_string(), "ok".to_string()])
        );
    }
}
