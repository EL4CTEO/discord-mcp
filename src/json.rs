//! Small accessors over raw Discord JSON, with JavaScript's notions of
//! "missing", "nullish" and "truthy" so ported conditions read the same.

use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

/// JS truthiness of an optional value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `value[key]` as a string, when it is one.
pub fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// `value[key]` as a string when it is a non-empty one (JS `if (value[key])`).
pub fn st<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    s(v, key).filter(|x| !x.is_empty())
}

pub fn i(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

pub fn b(v: &Value, key: &str) -> bool {
    truthy(v.get(key))
}

/// `value[key]` as an array, or an empty slice.
pub fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `value[key]` when present and not null.
pub fn present<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| !x.is_null())
}

/// The value's `id` string, or "".
pub fn id(v: &Value) -> &str {
    s(v, "id").unwrap_or("")
}

/// Builds a JSON object from (key, Option<Value>) pairs, dropping the `None`s
/// the way JSON.stringify drops `undefined`.
#[macro_export]
macro_rules! obj {
    ($($key:expr => $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut map = serde_json::Map::new();
        $( $crate::json::put(&mut map, $key, $value); )*
        serde_json::Value::Object(map)
    }};
}

/// Conversion for `obj!` values: plain values are always kept, `Option`s only when `Some`.
pub trait Field {
    fn field(self) -> Option<Value>;
}

impl Field for Value {
    fn field(self) -> Option<Value> {
        Some(self)
    }
}

impl<T: Into<Value>> Field for Option<T> {
    fn field(self) -> Option<Value> {
        self.map(Into::into)
    }
}

macro_rules! plain_field {
    ($($t:ty),*) => {$(
        impl Field for $t {
            fn field(self) -> Option<Value> { Some(Value::from(self)) }
        }
    )*};
}
plain_field!(String, &str, bool, i64, u64, i32, u32, usize, f64, Vec<Value>, Vec<String>, Map<String, Value>);

impl Field for &String {
    fn field(self) -> Option<Value> {
        Some(Value::from(self.as_str()))
    }
}

pub fn put(map: &mut Obj, key: &str, value: impl Field) {
    if let Some(v) = value.field() {
        map.insert(key.to_string(), v);
    }
}

/// `{...a, ...b}` for two objects (a non-object side contributes nothing).
pub fn spread(a: &Value, b: &Value) -> Value {
    let mut out = a.as_object().cloned().unwrap_or_default();
    if let Some(bm) = b.as_object() {
        for (k, v) in bm {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

pub fn strings(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}
